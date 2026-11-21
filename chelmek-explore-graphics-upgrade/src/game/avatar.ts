import * as THREE from "three";

export type AvatarId = "maja" | "olek" | "rysiek";

export const AVATAR_META: { id: AvatarId; name: string; line: string; blurb: string }[] = [
  {
    id: "maja",
    name: "Maja",
    line: "Płaszcz miodowy",
    blurb: "Szalik pod szyją, lekki krok po płycie placu.",
  },
  {
    id: "olek",
    name: "Olek",
    line: "Granatowa kurtka",
    blurb: "Spokojny chód wzdłuż Krakowskiej.",
  },
  {
    id: "rysiek",
    name: "Rysiek",
    line: "Bluza z osiedla Baty",
    blurb: "Czapka, robocza bluza, pamięć fabryki obuwia.",
  },
];

type Palette = {
  skin: number;
  hair: number;
  top: number;
  bottom: number;
  shoe: number;
  accent: number;
  hairStyle: "bun" | "short" | "cap";
  scale: number;
  shoulder: number;
};

const PALETTES: Record<AvatarId, Palette> = {
  maja: {
    skin: 0xe8b898,
    hair: 0x2a211c,
    top: 0xc9843a,
    bottom: 0x2c3140,
    shoe: 0x241e1c,
    accent: 0x7a2e38,
    hairStyle: "bun",
    scale: 0.96,
    shoulder: 0.2,
  },
  olek: {
    skin: 0xd7a27c,
    hair: 0x3a2a22,
    top: 0x24324a,
    bottom: 0xcbbfa6,
    shoe: 0x3a2e28,
    accent: 0xf3ecdf,
    hairStyle: "short",
    scale: 1,
    shoulder: 0.23,
  },
  rysiek: {
    skin: 0xc48a62,
    hair: 0x3e342c,
    top: 0xc46a2c,
    bottom: 0x4a5160,
    shoe: 0x2a241e,
    accent: 0xd9d3c4,
    hairStyle: "cap",
    scale: 1.06,
    shoulder: 0.28,
  },
};

export type AvatarParts = {
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  torso: THREE.Group;
};

function mat(hex: number, rough = 0.74) {
  return new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: 0.02 });
}

function limb(len: number, rad: number, cloth: THREE.Material, tip: THREE.Material) {
  const pivot = new THREE.Group();
  const upper = new THREE.Mesh(new THREE.CapsuleGeometry(rad, len * 0.55, 2, 6), cloth);
  upper.position.y = -len * 0.38;
  const end = new THREE.Mesh(new THREE.SphereGeometry(rad * 1.15, 8, 6), tip);
  end.position.y = -len * 0.78;
  end.scale.set(1, 0.72, 1.25);
  pivot.add(upper, end);
  return pivot;
}

export function createAvatar(id: AvatarId) {
  const p = PALETTES[id];
  const root = new THREE.Group();
  root.scale.setScalar(p.scale);
  const skin = mat(p.skin, 0.62);
  const hair = mat(p.hair, 0.55);
  const top = mat(p.top, 0.8);
  const bottom = mat(p.bottom, 0.82);
  const shoe = mat(p.shoe, 0.5);
  const accent = mat(p.accent, 0.6);

  const legL = limb(0.46, 0.075, bottom, shoe);
  const legR = limb(0.46, 0.075, bottom, shoe);
  legL.position.set(-0.11, 0.86, 0);
  legR.position.set(0.11, 0.86, 0);

  const torso = new THREE.Group();
  torso.position.y = 0.86;
  const coat = new THREE.Mesh(new THREE.CapsuleGeometry(p.shoulder, 0.42, 3, 8), top);
  coat.position.y = 0.28;
  torso.add(coat);
  const collar = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.055, 0.08), accent);
  collar.position.set(0, 0.5, p.shoulder * 0.45);
  torso.add(collar);

  const armL = limb(0.38, 0.055, top, skin);
  const armR = limb(0.38, 0.055, top, skin);
  armL.position.set(-p.shoulder - 0.02, 0.46, 0);
  armR.position.set(p.shoulder + 0.02, 0.46, 0);
  torso.add(armL, armR);

  const headPivot = new THREE.Group();
  headPivot.position.y = 0.58;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.145, 12, 10), skin);
  head.scale.set(1, 1.05, 1);
  headPivot.add(head);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.028, 6, 6), skin);
  nose.position.set(0, -0.01, 0.138);
  headPivot.add(nose);

  if (p.hairStyle === "bun") {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), hair);
    cap.scale.set(1.02, 0.68, 1.05);
    cap.position.y = 0.055;
    const bun = new THREE.Mesh(new THREE.SphereGeometry(0.068, 8, 8), hair);
    bun.position.set(0, 0.1, -0.08);
    const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.022, 6, 10), accent);
    scarf.position.set(0, -0.11, 0.02);
    scarf.rotation.x = Math.PI / 2;
    headPivot.add(cap, bun, scarf);
  } else if (p.hairStyle === "short") {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.152, 10, 8), hair);
    cap.scale.set(1.02, 0.6, 1.04);
    cap.position.y = 0.07;
    headPivot.add(cap);
  } else {
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.155, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      hair,
    );
    cap.position.y = 0.02;
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.018, 0.11), hair);
    brim.position.set(0, 0.02, 0.12);
    headPivot.add(cap, brim);
  }
  torso.add(headPivot);
  root.add(legL, legR, torso);

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.avatarId = id;
    }
  });
  root.userData.avatarId = id;
  root.userData.parts = { legL, legR, armL, armR, torso } satisfies AvatarParts;

  const discMat = new THREE.MeshBasicMaterial({
    color: 0xe2d6c4,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.52, 22), discMat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.06;
  disc.userData.avatarId = id;
  root.add(disc);
  root.userData.disc = disc;

  return root;
}

export function poseAvatar(root: THREE.Group, speed: number, phase: number, reduce: boolean) {
  const parts = root.userData.parts as AvatarParts;
  const walk = THREE.MathUtils.clamp(Math.abs(speed) / 3.4, 0, 1);
  if (reduce || walk < 0.05) {
    parts.legL.rotation.x = 0;
    parts.legR.rotation.x = 0;
    parts.armL.rotation.x = 0;
    parts.armR.rotation.x = 0;
    parts.torso.rotation.x = 0;
    parts.torso.position.y = 0.86 + Math.sin(phase) * 0.01;
    return;
  }
  const swing = Math.sin(phase) * walk;
  parts.legL.rotation.x = swing * 0.9;
  parts.legR.rotation.x = -swing * 0.9;
  parts.armL.rotation.x = -swing * 0.7;
  parts.armR.rotation.x = swing * 0.7;
  parts.torso.position.y = 0.86 + Math.abs(Math.sin(phase * 2)) * 0.03 * walk;
  parts.torso.rotation.x = 0.1 * walk;
}
