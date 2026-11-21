import * as THREE from "three";

/**
 * Deferred path in the spirit of RAGE's G-buffer, plus CSM, a CoC depth-of-field
 * resolve, and an IW-style volumetric march (height fog, local smoke, sun shafts
 * sampled from the cascades).
 *
 * WebGL2 has no fragment-shading-rate extension in shipping browsers, and WebGPU's
 * shading-rate feature is still not a core GPUFeature. Variable-rate work is
 * emulated: a tile classifier picks 1× / 2× / 4×, the march runs at half and
 * quarter resolution, and the lighting resolve picks the coarser buffer on flat
 * tiles. If a real shading-rate entry point ever shows up on the GL context it
 * is recorded and preferred for the volume pass.
 */

export type SmokeVolume = { x: number; y: number; z: number; r: number; density: number; rise?: boolean };

type ViewId = "final" | "albedo" | "normal" | "rough" | "cascade" | "shadow" | "fog" | "vrs";

const VIEWS: { id: ViewId; label: string }[] = [
  { id: "final", label: "Obraz" },
  { id: "albedo", label: "Albedo" },
  { id: "normal", label: "Normalne" },
  { id: "rough", label: "Szorstkość" },
  { id: "cascade", label: "Kaskady" },
  { id: "shadow", label: "Cień" },
  { id: "fog", label: "Mgła" },
  { id: "vrs", label: "VRS" },
];

const FULLSCREEN_VERT = /* glsl */ `
  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const GBUFFER_VERT = /* glsl */ `
  varying vec3 vWorldN;
  varying vec3 vColor;
  varying vec2 vUv;

  void main() {
    mat4 model = modelMatrix;
    #ifdef USE_INSTANCING
      model = modelMatrix * instanceMatrix;
    #endif
    vec4 world = model * vec4(position, 1.0);
    mat3 m3 = mat3(model);
    vWorldN = transpose(inverse(m3)) * normal;
    #ifdef USE_COLOR
      vColor = color;
    #else
      vColor = vec3(1.0);
    #endif
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const GBUFFER_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uRoughness;
  uniform float uMetalness;
  uniform float uUnlit;
  uniform sampler2D uMap;
  uniform float uHasMap;
  uniform float uMapSrgb;
  uniform vec2 uRepeat;
  uniform vec2 uOffset;
  varying vec3 vWorldN;
  varying vec3 vColor;
  varying vec2 vUv;
  layout(location = 0) out vec4 outAlbedo;
  layout(location = 1) out vec4 outNormal;
  layout(location = 2) out vec4 outMat;

  vec3 toLinear(vec3 c) {
    return pow(max(c, vec3(0.0)), vec3(2.2));
  }

  void main() {
    vec3 albedo = uColor * vColor;
    if (uHasMap > 0.5) {
      vec2 uv = vUv * uRepeat + uOffset;
      vec3 tex = texture(uMap, uv).rgb;
      if (uMapSrgb > 0.5) tex = toLinear(tex);
      albedo *= tex;
    }
    vec3 n = normalize(vWorldN);
    if (!gl_FrontFacing) n = -n;
    outAlbedo = vec4(albedo, 1.0);
    outNormal = vec4(n * 0.5 + 0.5, clamp(uRoughness, 0.045, 1.0));
    outMat = vec4(clamp(uMetalness, 0.0, 1.0), uUnlit, 0.0, 1.0);
  }
`;

const FORWARD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vUv = uv;
  }
`;

const FORWARD_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform sampler2D tDepth;
  uniform vec2 uResolution;
  varying vec2 vUv;
  layout(location = 0) out vec4 outColor;

  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float sceneZ = texture(tDepth, uv).r;
    if (gl_FragCoord.z > sceneZ) discard;
    outColor = vec4(uColor, uOpacity);
  }
`;

const RATE_FRAG = /* glsl */ `
  uniform sampler2D tDepth;
  uniform sampler2D tNormal;
  uniform vec2 uFullRes;
  layout(location = 0) out vec4 outRate;

  void main() {
    vec2 uv = gl_FragCoord.xy / (uFullRes * 0.25);
    vec2 o = 2.0 / uFullRes;
    float d0 = texture(tDepth, uv).r;
    float d1 = texture(tDepth, uv + vec2(o.x, 0.0)).r;
    float d2 = texture(tDepth, uv + vec2(0.0, o.y)).r;
    float d3 = texture(tDepth, uv - o).r;
    float varD = max(abs(d0 - d1), max(abs(d0 - d2), abs(d0 - d3)));
    vec3 n0 = texture(tNormal, uv).xyz * 2.0 - 1.0;
    vec3 n1 = texture(tNormal, uv + vec2(o.x, 0.0)).xyz * 2.0 - 1.0;
    float varN = 1.0 - dot(normalize(n0 + 1e-5), normalize(n1 + 1e-5));
    float rate = 4.0;
    if (d0 < 0.9995 && (varD > 0.0018 || varN > 0.06)) rate = 1.0;
    else if (d0 < 0.9995 && (varD > 0.00035 || varN > 0.02)) rate = 2.0;
    outRate = vec4(rate / 4.0, varD, varN, 1.0);
  }
`;

const VOLUME_FRAG = /* glsl */ `
  uniform sampler2D tDepth;
  uniform sampler2D tShadow0;
  uniform sampler2D tShadow1;
  uniform sampler2D tShadow2;
  uniform sampler2D tRate;
  uniform sampler2D tVolQuarter;
  uniform mat4 uInvProj;
  uniform mat4 uInvView;
  uniform mat4 uView;
  uniform mat4 uShadowVP0;
  uniform mat4 uShadowVP1;
  uniform mat4 uShadowVP2;
  uniform vec3 uSplits;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uFogAmb;
  uniform vec4 uSmoke0;
  uniform vec4 uSmoke1;
  uniform vec4 uSmoke2;
  uniform vec4 uSmoke3;
  uniform vec4 uSmokeDensity;
  uniform vec4 uSmokeRise;
  uniform vec2 uResolution;
  uniform float uTime;
  uniform float uMaxDist;
  uniform float uSteps;
  uniform float uUseQuarter;
  layout(location = 0) out vec4 outVol;

  vec3 worldAt(vec2 uv, float depth) {
    vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 view = uInvProj * clip;
    view /= max(abs(view.w), 1e-6) * sign(view.w);
    return (uInvView * view).xyz;
  }

  float shadowTap(vec3 p) {
    float vz = -(uView * vec4(p, 1.0)).z;
    vec4 clip;
    float texel;
    if (vz < uSplits.x) {
      clip = uShadowVP0 * vec4(p, 1.0);
      texel = 1.0 / 1024.0;
    } else if (vz < uSplits.y) {
      clip = uShadowVP1 * vec4(p, 1.0);
      texel = 1.0 / 1024.0;
    } else {
      clip = uShadowVP2 * vec4(p, 1.0);
      texel = 1.0 / 1024.0;
    }
    vec3 ndc = clip.xyz / clip.w;
    vec2 uv = ndc.xy * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || ndc.z < -1.0 || ndc.z > 1.0) return 1.0;
    float z = ndc.z * 0.5 + 0.5;
    float closest;
    if (vz < uSplits.x) closest = texture(tShadow0, uv).r;
    else if (vz < uSplits.y) closest = texture(tShadow1, uv).r;
    else closest = texture(tShadow2, uv).r;
    float bias = 0.0012 + texel;
    return (z - bias) > closest ? 0.35 : 1.0;
  }

  float puff(vec3 p, vec4 s, float density, float rise, float phase) {
    if (density < 0.001 || s.w < 0.1) return 0.0;
    vec3 c = s.xyz;
    float cycle = 8.0;
    float yoff = rise > 0.5 ? mod(uTime * 0.65 + phase, cycle) : 0.0;
    c.y += yoff;
    c.x += sin(uTime * 0.35 + phase) * (1.2 + rise);
    c.z += cos(uTime * 0.28 + phase * 1.7) * (0.8 + rise);
    float fade = rise > 0.5 ? smoothstep(0.0, 0.7, yoff) * smoothstep(cycle, cycle - 1.4, yoff) : 1.0;
    float d = length((p - c) / vec3(s.w, s.w * 1.35, s.w));
    return smoothstep(1.0, 0.15, d) * density * fade;
  }

  float densityAt(vec3 p) {
    float haze = 0.011 * exp(-max(p.y - 0.15, 0.0) * 0.16);
    haze += puff(p, uSmoke0, uSmokeDensity.x, uSmokeRise.x, 0.2);
    haze += puff(p, uSmoke1, uSmokeDensity.y, uSmokeRise.y, 1.7);
    haze += puff(p, uSmoke2, uSmokeDensity.z, uSmokeRise.z, 3.1);
    haze += puff(p, uSmoke3, uSmokeDensity.w, uSmokeRise.w, 4.4);
    return haze;
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    if (uUseQuarter < 0.5) {
      float rate = texture(tRate, uv).r;
      if (rate > 0.75) {
        outVol = texture(tVolQuarter, uv);
        return;
      }
    }
    float depth = texture(tDepth, uv).r;
    vec3 farWorld = worldAt(uv, depth > 0.9995 ? 0.985 : depth);
    vec3 ro = cameraPosition;
    vec3 rd = normalize(farWorld - ro);
    float dist = depth > 0.9995 ? uMaxDist : min(length(farWorld - ro), uMaxDist);
    float steps = max(uSteps, 1.0);
    float stepLen = dist / steps;
    vec3 scatter = vec3(0.0);
    float trans = 1.0;
    vec3 sunDir = normalize(uSunDir);
    for (int i = 0; i < 12; i++) {
      if (float(i) >= steps) break;
      float t = (float(i) + 0.5) * stepLen;
      vec3 p = ro + rd * t;
      float dens = densityAt(p);
      if (dens < 1e-4) continue;
      float sh = shadowTap(p);
      float mu = dot(rd, sunDir);
      float hg = (1.0 - 0.42 * 0.42) / pow(1.0 + 0.42 * 0.42 - 2.0 * 0.42 * mu, 1.5);
      vec3 light = uSunColor * sh * hg * 0.11 + uFogAmb;
      scatter += trans * dens * stepLen * light;
      trans *= exp(-dens * stepLen * 1.35);
    }
    outVol = vec4(scatter, trans);
  }
`;

const LIGHT_FRAG = /* glsl */ `
  uniform sampler2D tAlbedo;
  uniform sampler2D tNormal;
  uniform sampler2D tMat;
  uniform sampler2D tDepth;
  uniform sampler2D tShadow0;
  uniform sampler2D tShadow1;
  uniform sampler2D tShadow2;
  uniform sampler2D tVolHalf;
  uniform sampler2D tVolQuarter;
  uniform sampler2D tRate;
  uniform sampler2D tBlur;
  uniform sampler2D tSharp;
  uniform mat4 uInvProj;
  uniform mat4 uInvView;
  uniform mat4 uView;
  uniform mat4 uShadowVP0;
  uniform mat4 uShadowVP1;
  uniform mat4 uShadowVP2;
  uniform vec3 uSplits;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSky;
  uniform vec3 uGround;
  uniform vec3 uHorizon;
  uniform vec3 uSkyTop;
  uniform vec3 uSkyBottom;
  uniform vec2 uResolution;
  uniform vec2 uHalfRes;
  uniform float uDebug;
  uniform float uFocus;
  uniform float uNear;
  uniform float uFar;
  uniform float uExposure;
  uniform float uTime;
  uniform float uStage;
  layout(location = 0) out vec4 outColor;

  vec3 worldAt(vec2 uv, float depth) {
    vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 view = uInvProj * clip;
    view /= max(abs(view.w), 1e-6) * sign(view.w);
    return (uInvView * view).xyz;
  }

  float sampleCascade(int id, vec3 p, float bias) {
    mat4 vp = uShadowVP0;
    float texel = 1.0 / 1024.0;
    if (id == 1) { vp = uShadowVP1; }
    if (id == 2) { vp = uShadowVP2; texel = 1.0 / 1024.0; }
    vec4 clip = vp * vec4(p, 1.0);
    vec3 ndc = clip.xyz / clip.w;
    vec2 uv = ndc.xy * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || ndc.z < -1.0 || ndc.z > 1.0) return -1.0;
    float z = ndc.z * 0.5 + 0.5 - bias;
    float vis = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 suv = uv + vec2(float(x), float(y)) * texel;
        float closest;
        if (id == 0) closest = texture(tShadow0, suv).r;
        else if (id == 1) closest = texture(tShadow1, suv).r;
        else closest = texture(tShadow2, suv).r;
        vis += z > closest ? 0.0 : 1.0;
      }
    }
    return vis / 9.0;
  }

  vec3 aces(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }

  vec3 skyColor(vec3 rd) {
    float h = rd.y;
    vec3 col = mix(uHorizon, uSkyTop, smoothstep(0.02, 0.62, h));
    col = mix(uSkyBottom, col, smoothstep(-0.2, 0.08, h));
    float sun = pow(max(dot(rd, normalize(uSunDir)), 0.0), 180.0);
    col += vec3(1.0, 0.78, 0.48) * sun;
    return col;
  }

  float linearZ(float depth) {
    float z = depth * 2.0 - 1.0;
    return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
  }

  vec4 volAt(vec2 uv, float depth, float rate) {
    vec2 texel = (rate > 0.75 ? 4.0 : 2.0) / uResolution;
    vec4 acc = vec4(0.0);
    float wsum = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 u = uv + vec2(float(x), float(y)) * texel;
        float d = texture(tDepth, u).r;
        float w = exp(-abs(d - depth) * 220.0);
        vec4 v = rate > 0.75 ? texture(tVolQuarter, u) : texture(tVolHalf, u);
        acc += v * w;
        wsum += w;
      }
    }
    return acc / max(wsum, 1e-4);
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float depth = texture(tDepth, uv).r;
    float rate = texture(tRate, uv).r;

    if (uStage > 0.5) {
      vec3 albedo = texture(tAlbedo, uv).rgb;
      vec3 n = texture(tNormal, uv).xyz;
      float rough = texture(tNormal, uv).a;
      if (uDebug > 0.5 && uDebug < 1.5) {
        outColor = vec4(pow(albedo, vec3(1.0 / 2.2)), 1.0);
        return;
      }
      if (uDebug > 1.5 && uDebug < 2.5) {
        outColor = vec4(n, 1.0);
        return;
      }
      if (uDebug > 2.5 && uDebug < 3.5) {
        outColor = vec4(vec3(rough), 1.0);
        return;
      }
      if (uDebug > 3.5 && uDebug < 5.5) {
        outColor = vec4(texture(tSharp, uv).rgb, 1.0);
        return;
      }
      if (uDebug > 6.5) {
        vec3 mark = rate > 0.75 ? vec3(0.72, 0.22, 0.16) : rate > 0.35 ? vec3(0.86, 0.64, 0.22) : vec3(0.22, 0.55, 0.34);
        outColor = vec4(mark, 1.0);
        return;
      }
      vec3 color = texture(tSharp, uv).rgb;
      if (uDebug > 5.5 && uDebug < 6.5) {
        color = volAt(uv, depth, rate).rgb * 3.2;
      } else if (uDebug < 0.5) {
        float lz = linearZ(depth);
        float coc = clamp(abs(lz - uFocus) * 0.22 / max(uFocus, 0.5), 0.0, 1.0);
        color = mix(color, texture(tBlur, uv).rgb, smoothstep(0.04, 0.62, coc));
      }
      float exposure = (uDebug > 3.5 && uDebug < 6.5) ? 1.0 : uExposure;
      color = aces(max(color, vec3(0.0)) * exposure);
      outColor = vec4(pow(color, vec3(1.0 / 2.2)), 1.0);
      return;
    }

    vec3 albedo = texture(tAlbedo, uv).rgb;
    vec3 n = normalize(texture(tNormal, uv).xyz * 2.0 - 1.0);
    float rough = texture(tNormal, uv).a;
    float metal = texture(tMat, uv).r;
    float unlit = texture(tMat, uv).g;
    vec3 sunDir = normalize(uSunDir);
    vec3 color;
    float shadow = 1.0;
    int cascadeId = 2;
    if (depth > 0.9995) {
      vec3 rd = normalize(worldAt(uv, 0.985) - cameraPosition);
      color = skyColor(rd);
    } else {
      vec3 world = worldAt(uv, depth);
      vec3 v = normalize(cameraPosition - world);
      float vz = -(uView * vec4(world, 1.0)).z;
      float NoL = dot(n, sunDir);
      float slope = clamp(1.0 - max(NoL, 0.0), 0.0, 1.0);
      vec3 sp = world + n * (0.06 + slope * 0.12);
      if (vz < uSplits.x) cascadeId = 0;
      else if (vz < uSplits.y) cascadeId = 1;
      float bias = 0.00055 + slope * 0.0016;
      if (cascadeId == 1) bias *= 1.8;
      if (cascadeId == 2) bias *= 3.2;
      shadow = sampleCascade(cascadeId, sp, bias);
      if (cascadeId == 0 && vz > uSplits.x - 4.0) {
        float s2 = sampleCascade(1, sp, bias * 1.8);
        if (shadow >= 0.0 && s2 >= 0.0) shadow = mix(shadow, s2, smoothstep(uSplits.x - 4.0, uSplits.x, vz));
        else if (shadow < 0.0) shadow = s2;
      } else if (cascadeId == 1 && vz > uSplits.y - 6.0) {
        float s2 = sampleCascade(2, sp, bias * 1.6);
        if (shadow >= 0.0 && s2 >= 0.0) shadow = mix(shadow, s2, smoothstep(uSplits.y - 6.0, uSplits.y, vz));
        else if (shadow < 0.0) shadow = s2;
      }
      if (shadow < 0.0) shadow = 1.0;
      if (uDebug > 3.5 && uDebug < 5.5) {
        vec3 mark = cascadeId == 0 ? vec3(0.85, 0.28, 0.22) : cascadeId == 1 ? vec3(0.25, 0.72, 0.38) : vec3(0.28, 0.46, 0.92);
        if (uDebug > 4.5) mark = vec3(shadow);
        else mark *= 0.45 + 0.55 * shadow;
        outColor = vec4(mark, 1.0);
        return;
      }
      if (unlit > 0.5) {
        color = albedo;
      } else {
        vec3 h = normalize(sunDir + v);
        float NoV = max(dot(n, v), 0.04);
        float NoH = max(dot(n, h), 0.0);
        float VoH = max(dot(v, h), 0.0);
        float a = rough * rough;
        float a2 = a * a;
        float d = NoH * NoH * (a2 - 1.0) + 1.0;
        float D = a2 / max(3.14159 * d * d, 1e-4);
        float k = (rough + 1.0);
        k = k * k * 0.125;
        float G = (NoL / max(NoL * (1.0 - k) + k, 1e-4)) * (NoV / max(NoV * (1.0 - k) + k, 1e-4));
        vec3 F0 = mix(vec3(0.04), albedo, metal);
        vec3 F = F0 + (1.0 - F0) * pow(1.0 - VoH, 5.0);
        vec3 spec = D * G * F / max(4.0 * max(NoL, 0.0) * NoV, 1e-3);
        vec3 diff = albedo * (1.0 - metal) * 0.3183;
        float ndl = max(NoL, 0.0);
        vec3 direct = (diff + spec) * uSunColor * ndl * shadow;
        float hemi = n.y * 0.5 + 0.5;
        vec3 amb = mix(uGround, uSky, hemi) * albedo * (1.0 - metal * 0.6);
        float fres = pow(1.0 - NoV, 5.0);
        vec3 water = vec3(0.55, 0.72, 0.74) * fres * (0.15 + 0.45 * shadow) * smoothstep(0.55, 0.2, rough);
        color = direct + amb + water;
      }
    }

    vec4 vol = volAt(uv, depth, rate);
    color = color * vol.a + vol.rgb;
    outColor = vec4(max(color, vec3(0.0)), 1.0);
  }
`;

const BLUR_FRAG = /* glsl */ `
  uniform sampler2D tSharp;
  uniform sampler2D tDepth;
  uniform vec2 uResolution;
  uniform vec2 uSharpRes;
  uniform float uFocus;
  uniform float uNear;
  uniform float uFar;
  layout(location = 0) out vec4 outColor;

  float linearZ(float depth) {
    float z = depth * 2.0 - 1.0;
    return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float depth = texture(tDepth, uv).r;
    float lz = linearZ(depth);
    float coc = clamp(abs(lz - uFocus) * 0.22 / max(uFocus, 0.5), 0.0, 1.0);
    vec2 texel = 1.0 / uSharpRes;
    float radius = mix(0.0, 7.0, coc);
    vec3 acc = texture(tSharp, uv).rgb;
    float wsum = 1.0;
    for (int i = 0; i < 10; i++) {
      float a = float(i) * 6.28318 / 10.0;
      vec2 o = vec2(cos(a), sin(a)) * radius * texel * (0.55 + 0.45 * float(i) / 10.0);
      float d = texture(tDepth, uv + o).r;
      float w = exp(-abs(linearZ(d) - lz) * 0.08) * (0.35 + 0.65 * coc);
      acc += texture(tSharp, uv + o).rgb * w;
      wsum += w;
    }
    outColor = vec4(acc / wsum, 1.0);
  }
`;

type VRSNative = { name: string };

function probeVRS(gl: WebGL2RenderingContext): VRSNative | null {
  const names = ["EXT_fragment_shading_rate", "WEBGL_fragment_shading_rate", "KHR_fragment_shading_rate"];
  for (const name of names) {
    const ext = gl.getExtension(name) as { shadingRateEXT?: (x: number, y: number) => void } | null;
    if (ext && typeof ext.shadingRateEXT === "function") return { name };
  }
  return null;
}

function target(w: number, h: number, type: THREE.TextureDataType, filter: THREE.MagnificationTextureFilter, depth = false) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type,
    format: THREE.RGBAFormat,
    magFilter: filter,
    minFilter: filter,
    depthBuffer: depth,
    stencilBuffer: false,
    generateMipmaps: false,
    colorSpace: THREE.NoColorSpace,
  });
  if (depth) {
    rt.depthTexture = new THREE.DepthTexture(Math.max(1, w), Math.max(1, h));
    rt.depthTexture.format = THREE.DepthFormat;
    rt.depthTexture.type = THREE.UnsignedIntType;
  }
  return rt;
}

function pass(frag: string, uniforms: Record<string, THREE.IUniform>) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: frag,
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const cam = new THREE.Camera();
  return { scene, cam, mat, geo };
}

const whiteData = new Uint8Array([255, 255, 255, 255]);

export class DeferredPipeline {
  view: ViewId = "final";
  readonly vrsNative: string | null;
  cascades = 3;
  private renderer: THREE.WebGLRenderer;
  private failed = false;
  private prepared = false;
  private width = 2;
  private height = 2;
  private gbuffer: THREE.WebGLRenderTarget;
  private hdr: THREE.WebGLRenderTarget;
  private blur: THREE.WebGLRenderTarget;
  private volHalf: THREE.WebGLRenderTarget;
  private volQuarter: THREE.WebGLRenderTarget;
  private rate: THREE.WebGLRenderTarget;
  private shadows: THREE.WebGLRenderTarget[];
  private shadowCams: THREE.OrthographicCamera[];
  private shadowVP: THREE.Matrix4[];
  private depthMat: THREE.MeshDepthMaterial;
  private gbMats = new Map<string, THREE.ShaderMaterial>();
  private fwMats = new Map<string, THREE.ShaderMaterial>();
  private white: THREE.DataTexture;
  private ratePass;
  private volPass;
  private lightPass;
  private blurPass;
  private splits = new THREE.Vector3(12, 36, 110);
  private smoke: SmokeVolume[] = [];
  private corners = Array.from({ length: 8 }, () => new THREE.Vector3());
  private center = new THREE.Vector3();
  private buf = new THREE.Vector2();
  private tmp = new THREE.Vector3();
  private snapped = new THREE.Vector3();
  private lightUp = new THREE.Vector3(0, 1, 0);
  private readonly mapSize = 1024;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.vrsNative = probeVRS(gl)?.name ?? null;
    const floatBuf = !!gl.getExtension("EXT_color_buffer_float");
    const hdrType = floatBuf ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.gbuffer = new THREE.WebGLRenderTarget(2, 2, {
      count: 3,
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.gbuffer.depthTexture = new THREE.DepthTexture(2, 2);
    this.gbuffer.depthTexture.format = THREE.DepthFormat;
    this.gbuffer.depthTexture.type = THREE.UnsignedIntType;
    this.hdr = target(2, 2, hdrType, THREE.NearestFilter, false);
    this.blur = target(2, 2, hdrType, THREE.LinearFilter, false);
    this.volHalf = target(2, 2, hdrType, THREE.LinearFilter, false);
    this.volQuarter = target(2, 2, hdrType, THREE.LinearFilter, false);
    this.rate = target(2, 2, THREE.UnsignedByteType, THREE.NearestFilter, false);
    this.shadows = [0, 1, 2].map(() => {
      const rt = target(this.mapSize, this.mapSize, THREE.UnsignedByteType, THREE.NearestFilter, true);
      return rt;
    });
    this.shadowCams = [0, 1, 2].map(() => {
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.5, 200);
      cam.layers.set(1);
      return cam;
    });
    this.shadowVP = [0, 1, 2].map(() => new THREE.Matrix4());
    this.depthMat = new THREE.MeshDepthMaterial();
    this.depthMat.depthPacking = THREE.RGBADepthPacking;
    this.depthMat.side = THREE.DoubleSide;
    this.depthMat.polygonOffset = true;
    this.depthMat.polygonOffsetFactor = 1.4;
    this.depthMat.polygonOffsetUnits = 2.0;
    this.white = new THREE.DataTexture(whiteData, 1, 1);
    this.white.needsUpdate = true;
    this.white.colorSpace = THREE.LinearSRGBColorSpace;

    const depth = () => ({ value: this.gbuffer.depthTexture });
    const albedo = () => ({ value: this.gbuffer.textures[0] });
    const normal = () => ({ value: this.gbuffer.textures[1] });
    this.ratePass = pass(RATE_FRAG, {
      tDepth: depth(),
      tNormal: normal(),
      uFullRes: { value: new THREE.Vector2(2, 2) },
    });
    this.volPass = pass(VOLUME_FRAG, {
      tDepth: depth(),
      tShadow0: { value: this.shadows[0].depthTexture },
      tShadow1: { value: this.shadows[1].depthTexture },
      tShadow2: { value: this.shadows[2].depthTexture },
      tRate: { value: this.rate.texture },
      tVolQuarter: { value: this.volQuarter.texture },
      uInvProj: { value: new THREE.Matrix4() },
      uInvView: { value: new THREE.Matrix4() },
      uView: { value: new THREE.Matrix4() },
      uShadowVP0: { value: this.shadowVP[0] },
      uShadowVP1: { value: this.shadowVP[1] },
      uShadowVP2: { value: this.shadowVP[2] },
      uSplits: { value: this.splits },
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3) },
      uSunColor: { value: new THREE.Color(3.1, 2.35, 1.7) },
      uFogAmb: { value: new THREE.Color(0.55, 0.5, 0.42) },
      uSmoke0: { value: new THREE.Vector4() },
      uSmoke1: { value: new THREE.Vector4() },
      uSmoke2: { value: new THREE.Vector4() },
      uSmoke3: { value: new THREE.Vector4() },
      uSmokeDensity: { value: new THREE.Vector4() },
      uSmokeRise: { value: new THREE.Vector4() },
      uResolution: { value: new THREE.Vector2(2, 2) },
      uTime: { value: 0 },
      uMaxDist: { value: 78 },
      uSteps: { value: 8 },
      uUseQuarter: { value: 1 },
    });
    this.lightPass = pass(LIGHT_FRAG, {
      tAlbedo: albedo(),
      tNormal: normal(),
      tMat: { value: this.gbuffer.textures[2] },
      tDepth: depth(),
      tShadow0: { value: this.shadows[0].depthTexture },
      tShadow1: { value: this.shadows[1].depthTexture },
      tShadow2: { value: this.shadows[2].depthTexture },
      tVolHalf: { value: this.volHalf.texture },
      tVolQuarter: { value: this.volQuarter.texture },
      tRate: { value: this.rate.texture },
      tBlur: { value: this.blur.texture },
      tSharp: { value: this.hdr.texture },
      uInvProj: { value: new THREE.Matrix4() },
      uInvView: { value: new THREE.Matrix4() },
      uView: { value: new THREE.Matrix4() },
      uShadowVP0: { value: this.shadowVP[0] },
      uShadowVP1: { value: this.shadowVP[1] },
      uShadowVP2: { value: this.shadowVP[2] },
      uSplits: { value: this.splits },
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3) },
      uSunColor: { value: new THREE.Color(3.15, 2.45, 1.75) },
      uSky: { value: new THREE.Color(0.62, 0.7, 0.78) },
      uGround: { value: new THREE.Color(0.42, 0.34, 0.24) },
      uHorizon: { value: new THREE.Color(0.84, 0.76, 0.64) },
      uSkyTop: { value: new THREE.Color(0.49, 0.68, 0.83) },
      uSkyBottom: { value: new THREE.Color(0.79, 0.71, 0.56) },
      uResolution: { value: new THREE.Vector2(2, 2) },
      uHalfRes: { value: new THREE.Vector2(2, 2) },
      uDebug: { value: 0 },
      uFocus: { value: 8 },
      uNear: { value: 0.15 },
      uFar: { value: 7000 },
      uExposure: { value: 1.08 },
      uTime: { value: 0 },
      uStage: { value: 0 },
    });
    this.blurPass = pass(BLUR_FRAG, {
      tSharp: { value: this.hdr.texture },
      tDepth: depth(),
      uResolution: { value: new THREE.Vector2(2, 2) },
      uSharpRes: { value: new THREE.Vector2(2, 2) },
      uFocus: { value: 8 },
      uNear: { value: 0.15 },
      uFar: { value: 7000 },
    });
    renderer.shadowMap.enabled = false;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.autoClear = false;
  }

  setSmoke(volumes: SmokeVolume[]) {
    this.smoke = volumes.slice(0, 4);
  }

  setSize(width: number, height: number) {
    const w = Math.max(2, Math.floor(width));
    const h = Math.max(2, Math.floor(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.gbuffer.setSize(w, h);
    this.hdr.setSize(w, h);
    this.blur.setSize(Math.max(2, w >> 1), Math.max(2, h >> 1));
    this.volHalf.setSize(Math.max(2, w >> 1), Math.max(2, h >> 1));
    this.volQuarter.setSize(Math.max(2, w >> 2), Math.max(2, h >> 2));
    this.rate.setSize(Math.max(2, w >> 2), Math.max(2, h >> 2));
    const u = this.lightPass.mat.uniforms;
    (u.uResolution.value as THREE.Vector2).set(w, h);
    (u.uHalfRes.value as THREE.Vector2).set(w >> 1, h >> 1);
    (this.ratePass.mat.uniforms.uFullRes.value as THREE.Vector2).set(w, h);
    (this.blurPass.mat.uniforms.uResolution.value as THREE.Vector2).set(w >> 1, h >> 1);
    (this.blurPass.mat.uniforms.uSharpRes.value as THREE.Vector2).set(w, h);
  }

  cycleView() {
    const i = VIEWS.findIndex((v) => v.id === this.view);
    this.view = VIEWS[(i + 1) % VIEWS.length].id;
    return this.viewLabel();
  }

  viewLabel() {
    return VIEWS.find((v) => v.id === this.view)?.label ?? "Obraz";
  }

  label() {
    const vrs = this.vrsNative ? `VRS ${this.vrsNative}` : "VRS 2×/4×";
    return `G-buffer · CSM×${this.cascades} · DoF · volumetric · ${vrs}`;
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, sunDir: THREE.Vector3, focus: number, time: number) {
    if (this.failed) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, camera);
      return;
    }
    const buf = this.renderer.getDrawingBufferSize(this.buf);
    this.setSize(buf.x, buf.y);
    if (!this.prepared) this.prepare(scene);
    this.fitShadows(camera, sunDir);
    this.drawShadows(scene);
    this.drawGBuffer(scene, camera);
    this.syncFrame(camera, sunDir, focus, time);
    const r = this.renderer;
    r.setRenderTarget(this.rate);
    r.clear(true, false, false);
    r.render(this.ratePass.scene, this.ratePass.cam);

    const volU = this.volPass.mat.uniforms;
    volU.uUseQuarter.value = 1;
    volU.uSteps.value = 6;
    (volU.uResolution.value as THREE.Vector2).set(this.volQuarter.width, this.volQuarter.height);
    r.setRenderTarget(this.volQuarter);
    r.setClearColor(0x000000, 1);
    r.clear(true, false, false);
    r.render(this.volPass.scene, this.volPass.cam);

    volU.uUseQuarter.value = 0;
    volU.uSteps.value = this.width < 900 ? 7 : 10;
    (volU.uResolution.value as THREE.Vector2).set(this.volHalf.width, this.volHalf.height);
    r.setRenderTarget(this.volHalf);
    r.clear(true, false, false);
    r.render(this.volPass.scene, this.volPass.cam);

    const debug = this.debugValue();
    const lightU = this.lightPass.mat.uniforms;
    lightU.uStage.value = 0;
    lightU.uDebug.value = debug === 4 || debug === 5 ? debug : 0;
    r.setRenderTarget(this.hdr);
    r.clear(true, false, false);
    r.render(this.lightPass.scene, this.lightPass.cam);
    if (debug !== 4 && debug !== 5) this.drawTransparent(scene, camera);

    if (debug === 0) {
      r.setRenderTarget(this.blur);
      r.clear(true, false, false);
      r.render(this.blurPass.scene, this.blurPass.cam);
    }
    lightU.uStage.value = 1;
    lightU.uDebug.value = debug;
    r.setRenderTarget(null);
    r.setClearColor(0x1c1712, 1);
    r.clear(true, true, true);
    r.render(this.lightPass.scene, this.lightPass.cam);
  }

  dispose() {
    this.gbuffer.dispose();
    this.hdr.dispose();
    this.blur.dispose();
    this.volHalf.dispose();
    this.volQuarter.dispose();
    this.rate.dispose();
    for (const s of this.shadows) s.dispose();
    this.depthMat.dispose();
    this.white.dispose();
    for (const m of this.gbMats.values()) m.dispose();
    for (const m of this.fwMats.values()) m.dispose();
    this.ratePass.geo.dispose();
    this.ratePass.mat.dispose();
    this.volPass.geo.dispose();
    this.volPass.mat.dispose();
    this.lightPass.geo.dispose();
    this.lightPass.mat.dispose();
    this.blurPass.geo.dispose();
    this.blurPass.mat.dispose();
  }

  private debugValue() {
    return VIEWS.findIndex((v) => v.id === this.view);
  }

  private prepare(scene: THREE.Scene) {
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.Material;
      if (!mat || Array.isArray(mat)) return;
      if ((mat as THREE.ShaderMaterial).isShaderMaterial && !(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
        mesh.layers.set(3);
        return;
      }
      if (mat.transparent && mat.opacity < 0.999) {
        mesh.layers.set(2);
        mesh.castShadow = false;
        return;
      }
      mesh.layers.set(0);
      if (mesh.castShadow) mesh.layers.enable(1);
    });
    this.prepared = true;
  }

  private gbufferMaterial(src: THREE.Material) {
    let mat = this.gbMats.get(src.uuid);
    if (mat) return mat;
    const std = src as THREE.MeshStandardMaterial;
    const basic = src as THREE.MeshBasicMaterial;
    const isBasic = basic.isMeshBasicMaterial === true;
    const map = std.map ?? basic.map ?? null;
    mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: GBUFFER_VERT,
      fragmentShader: GBUFFER_FRAG,
      uniforms: {
        uColor: { value: (isBasic ? basic.color : std.color) ?? new THREE.Color(0xffffff) },
        uRoughness: { value: isBasic ? 1 : (std.roughness ?? 1) },
        uMetalness: { value: isBasic ? 0 : (std.metalness ?? 0) },
        uUnlit: { value: isBasic ? 1 : 0 },
        uMap: { value: map ?? this.white },
        uHasMap: { value: map ? 1 : 0 },
        uMapSrgb: { value: map && map.colorSpace === THREE.SRGBColorSpace ? 1 : 0 },
        uRepeat: { value: map ? map.repeat : new THREE.Vector2(1, 1) },
        uOffset: { value: map ? map.offset : new THREE.Vector2() },
      },
      side: src.side,
      vertexColors: !!(std.vertexColors || basic.vertexColors),
      toneMapped: false,
      fog: false,
    });
    this.gbMats.set(src.uuid, mat);
    return mat;
  }

  private forwardMaterial(src: THREE.Material) {
    let mat = this.fwMats.get(src.uuid);
    if (mat) return mat;
    const basic = src as THREE.MeshBasicMaterial;
    mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FORWARD_VERT,
      fragmentShader: FORWARD_FRAG,
      uniforms: {
        uColor: { value: basic.color ?? new THREE.Color(0xffffff) },
        uOpacity: { value: src.opacity },
        tDepth: { value: this.gbuffer.depthTexture },
        uResolution: { value: new THREE.Vector2(this.width, this.height) },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.fwMats.set(src.uuid, mat);
    return mat;
  }

  private drawGBuffer(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    const saved: { mesh: THREE.Mesh; mat: THREE.Material | THREE.Material[] }[] = [];
    camera.layers.set(0);
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.layers.test(camera.layers)) return;
      const src = mesh.material;
      if (!src || Array.isArray(src)) return;
      saved.push({ mesh, mat: src });
      mesh.material = this.gbufferMaterial(src);
    });
    const r = this.renderer;
    r.setRenderTarget(this.gbuffer);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, true);
    r.render(scene, camera);
    for (const item of saved) item.mesh.material = item.mat;
  }

  private drawTransparent(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    const saved: { mesh: THREE.Mesh; mat: THREE.Material | THREE.Material[] }[] = [];
    camera.layers.set(2);
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.layers.test(camera.layers)) return;
      const src = mesh.material;
      if (!src || Array.isArray(src)) return;
      const mat = this.forwardMaterial(src);
      mat.uniforms.uOpacity.value = src.opacity;
      (mat.uniforms.uResolution.value as THREE.Vector2).set(this.width, this.height);
      saved.push({ mesh, mat: src });
      mesh.material = mat;
    });
    if (saved.length) {
      this.renderer.setRenderTarget(this.hdr);
      this.renderer.render(scene, camera);
    }
    camera.layers.set(0);
    for (const item of saved) item.mesh.material = item.mat;
  }

  private drawShadows(scene: THREE.Scene) {
    const r = this.renderer;
    const prev = scene.overrideMaterial;
    scene.overrideMaterial = this.depthMat;
    for (let i = 0; i < 3; i++) {
      r.setRenderTarget(this.shadows[i]);
      r.setClearColor(0xffffff, 1);
      r.clear(true, true, true);
      r.render(scene, this.shadowCams[i]);
      this.shadowVP[i].multiplyMatrices(this.shadowCams[i].projectionMatrix, this.shadowCams[i].matrixWorldInverse);
    }
    scene.overrideMaterial = prev;
  }

  private fitShadows(camera: THREE.PerspectiveCamera, sunDir: THREE.Vector3) {
    const dir = this.tmp.copy(sunDir).normalize();
    const ends = [this.splits.x, this.splits.y, this.splits.z];
    let prev = Math.max(camera.near, 0.2);
    if (Math.abs(dir.y) > 0.92) this.lightUp.set(0, 0, 1);
    else this.lightUp.set(0, 1, 0);
    for (let i = 0; i < 3; i++) {
      const far = ends[i];
      this.frustumCorners(camera, prev, far);
      this.center.set(0, 0, 0);
      for (const c of this.corners) this.center.add(c);
      this.center.multiplyScalar(0.125);
      let radius = 0.5;
      for (const c of this.corners) radius = Math.max(radius, this.snapped.copy(c).sub(this.center).length());
      radius *= 1.18;
      const texelWorld = (radius * 2) / this.mapSize;
      radius = Math.ceil(radius / texelWorld) * texelWorld;
      const cam = this.shadowCams[i];
      cam.position.copy(this.center).addScaledVector(dir, radius + 50);
      cam.up.copy(this.lightUp);
      cam.lookAt(this.center);
      cam.left = -radius;
      cam.right = radius;
      cam.top = radius;
      cam.bottom = -radius;
      cam.near = 0.5;
      cam.far = radius * 2 + 140;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      this.snapped.copy(this.center).applyMatrix4(cam.matrixWorldInverse);
      this.snapped.x = Math.floor(this.snapped.x / texelWorld) * texelWorld;
      this.snapped.y = Math.floor(this.snapped.y / texelWorld) * texelWorld;
      this.snapped.applyMatrix4(cam.matrixWorld);
      cam.position.add(this.snapped.sub(this.center));
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      prev = far;
    }
  }

  private frustumCorners(cam: THREE.PerspectiveCamera, zNear: number, zFar: number) {
    const tan = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
    const nearH = tan * zNear;
    const nearW = nearH * cam.aspect;
    const farH = tan * zFar;
    const farW = farH * cam.aspect;
    const raw = [
      [-nearW, -nearH, -zNear],
      [nearW, -nearH, -zNear],
      [nearW, nearH, -zNear],
      [-nearW, nearH, -zNear],
      [-farW, -farH, -zFar],
      [farW, -farH, -zFar],
      [farW, farH, -zFar],
      [-farW, farH, -zFar],
    ];
    for (let i = 0; i < 8; i++) {
      this.corners[i].set(raw[i][0], raw[i][1], raw[i][2]).applyMatrix4(cam.matrixWorld);
    }
  }

  private syncFrame(camera: THREE.PerspectiveCamera, sunDir: THREE.Vector3, focus: number, time: number) {
    const packs = [this.volPass.mat.uniforms, this.lightPass.mat.uniforms];
    for (const u of packs) {
      (u.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
      (u.uInvView.value as THREE.Matrix4).copy(camera.matrixWorld);
      (u.uView.value as THREE.Matrix4).copy(camera.matrixWorldInverse);
      (u.uSunDir.value as THREE.Vector3).copy(sunDir);
      u.uTime.value = time;
    }
    const slots = [this.volPass.mat.uniforms.uSmoke0, this.volPass.mat.uniforms.uSmoke1, this.volPass.mat.uniforms.uSmoke2, this.volPass.mat.uniforms.uSmoke3];
    const density = this.volPass.mat.uniforms.uSmokeDensity.value as THREE.Vector4;
    const rise = this.volPass.mat.uniforms.uSmokeRise.value as THREE.Vector4;
    const dens = [0, 0, 0, 0];
    const rises = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const s = this.smoke[i];
      const v = slots[i].value as THREE.Vector4;
      if (!s) v.set(0, 0, 0, 0);
      else v.set(s.x, s.y, s.z, s.r);
      dens[i] = s?.density ?? 0;
      rises[i] = s?.rise ? 1 : 0;
    }
    density.set(dens[0], dens[1], dens[2], dens[3]);
    rise.set(rises[0], rises[1], rises[2], rises[3]);
    this.lightPass.mat.uniforms.uFocus.value = Math.max(0.5, focus);
    this.blurPass.mat.uniforms.uFocus.value = Math.max(0.5, focus);
    this.lightPass.mat.uniforms.uNear.value = camera.near;
    this.lightPass.mat.uniforms.uFar.value = camera.far;
    this.blurPass.mat.uniforms.uNear.value = camera.near;
    this.blurPass.mat.uniforms.uFar.value = camera.far;
    const narrow = this.width < 900;
    this.splits.set(narrow ? 9 : 12, narrow ? 28 : 38, narrow ? 70 : 110);
  }
}
