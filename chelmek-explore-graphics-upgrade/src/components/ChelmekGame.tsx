import { useEffect, useRef, useState } from "react";
import { BookOpen, Compass, Footprints, MapPin, RotateCcw, Sparkles, Volume2, VolumeX } from "lucide-react";
import { AVATAR_META, type AvatarId } from "@/game/avatar";
import type { GameHandle, Landmark } from "@/game/engine";

type Phase = "load" | "pick" | "walk";
type Place = { name: string; kind: string };

const SAVE_KEY = "chelmek-walk-v1";

const ACCENT: Record<AvatarId, string> = {
  maja: "bg-gold",
  olek: "bg-pine",
  rysiek: "bg-brick",
};

function kindLabel(kind: string, name: string) {
  const n = name.toLowerCase();
  if (n.includes("przemsza") || kind === "river") return "Rzeka";
  if (n.includes("kościół") || n.includes("kaplica") || kind === "church") return "Kościół";
  if (n.includes("urząd")) return "Urząd";
  if (n.includes("dworzec") || kind === "station") return "Kolej";
  if (kind === "cinema" || n.includes("kino")) return "Kino";
  if (
    kind === "memorial" ||
    kind === "monument" ||
    n.includes("pomnik") ||
    n.includes("aussen") ||
    n.includes("faszyzm")
  )
    return "Pamięć";
  if (n.includes("biblioteka")) return "Biblioteka";
  if (n.includes("poczta")) return "Poczta";
  if (n.includes("ośrodek")) return "Kultura";
  if (n.includes("osp")) return "Straż";
  if (n.includes("krasnal") || n.includes("młyń")) return "Ciekawostka";
  return "Miejsce";
}

function compassLabel(yaw: number) {
  const deg = (((-yaw * 180) / Math.PI) % 360 + 360) % 360;
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8] ?? "N";
}

export function ChelmekGame() {
  const viewRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<GameHandle | null>(null);
  const stickOrigin = useRef({ x: 0, y: 0 });
  const [phase, setPhase] = useState<Phase>("load");
  const [progress, setProgress] = useState({ t: 0.05, label: "Otwieram mapę Chełmka…" });
  const [avatar, setAvatar] = useState<AvatarId>("maja");
  const [street, setStreet] = useState("Plac Jana Kilińskiego");
  const [near, setNear] = useState<Place | null>(null);
  const [landmarks, setLandmarks] = useState<Landmark[]>([]);
  const [found, setFound] = useState<Set<string>>(new Set());
  const [journal, setJournal] = useState(false);
  const [sound, setSound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [heading, setHeading] = useState("N");
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const [running, setRunning] = useState(false);
  const [gfx, setGfx] = useState("Auto");

  const bus = useRef({
    onProgress: (t: number, label: string) => setProgress({ t, label }),
    onReady: (list: Landmark[]) => {
      setLandmarks(list);
      setPhase("pick");
    },
    onStreet: (name: string) => setStreet(name),
    onDiscover: (id: string) => {
      setFound((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    },
    onNear: (place: Place | null) => setNear(place),
    onFail: (message: string) => setError(message),
  });

  useEffect(() => {
    const view = viewRef.current;
    const mini = miniRef.current;
    if (!view || !mini) return;
    let dead = false;
    let handle: GameHandle | null = null;
    void (async () => {
      try {
        const { mountGame } = await import("@/game/engine");
        if (dead) return;
        handle = await mountGame({ view, mini, bus });
        if (dead) {
          handle.dispose();
          return;
        }
        handleRef.current = handle;
        setGfx(handle.gfxLabel());
        try {
          const raw = localStorage.getItem(SAVE_KEY);
          if (!raw) return;
          const saved = JSON.parse(raw) as { avatar?: AvatarId; found?: string[] };
          if (saved.avatar === "maja" || saved.avatar === "olek" || saved.avatar === "rysiek") {
            setAvatar(saved.avatar);
            handle.setAvatar(saved.avatar);
          }
          if (saved.found?.length) setFound(new Set(saved.found));
        } catch {
          /* ignore a broken save */
        }
      } catch (err) {
        if (!dead) setError(err instanceof Error ? err.message : "Nie udało się złożyć miasta.");
      }
    })();
    return () => {
      dead = true;
      handle?.dispose();
      handleRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (phase === "load") return;
    localStorage.setItem(SAVE_KEY, JSON.stringify({ v: 1, avatar, found: [...found] }));
  }, [avatar, found, phase]);

  useEffect(() => {
    if (phase !== "walk") return;
    const id = window.setInterval(() => {
      setHeading(compassLabel(handleRef.current?.getYaw() ?? 0));
    }, 180);
    return () => window.clearInterval(id);
  }, [phase]);

  function choose(id: AvatarId) {
    setAvatar(id);
    handleRef.current?.setAvatar(id);
  }

  function enterTown() {
    handleRef.current?.setAvatar(avatar);
    handleRef.current?.startWalk();
    setPhase("walk");
    setJournal(false);
    setNear(null);
  }

  function backToPeople() {
    handleRef.current?.backToSelect();
    setPhase("pick");
    setRunning(false);
    setKnob({ x: 0, y: 0 });
    handleRef.current?.setTouch(0, 0);
    handleRef.current?.setRun(false);
  }

  const foundCount = landmarks.filter((mark) => found.has(mark.id)).length;

  return (
    <main className="relative h-full w-full overflow-hidden bg-ink text-ink">
      <canvas ref={viewRef} className="absolute inset-0 h-full w-full touch-none" />
      <canvas
        ref={miniRef}
        aria-hidden="true"
        className={
          "pointer-events-none absolute top-3 right-3 z-10 h-36 w-36 rounded-2xl border border-line " +
          (phase === "walk" ? "opacity-100" : "invisible")
        }
      />

      {error ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center p-6">
          <section className="max-w-md rounded-2xl bg-paper p-6 text-ink">
            <h1 className="font-display text-3xl">Coś poszło nie tak</h1>
            <p className="mt-3 text-sm text-muted">{error}</p>
          </section>
        </div>
      ) : null}

      {phase === "load" && !error ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center p-5">
          <section className="w-full max-w-md rounded-2xl bg-paper px-6 py-7 text-ink">
            <p className="text-xs font-semibold tracking-widest text-brick uppercase">
              Małopolskie · 32-660
            </p>
            <h1 className="mt-2 font-display text-5xl leading-none">Chełmek</h1>
            <p className="mt-4 text-sm leading-relaxed text-muted">{progress.label}</p>
            <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-line">
              <div className="h-full bg-brick transition-all" style={{ width: `${Math.round(progress.t * 100)}%` }} />
            </div>
          </section>
        </div>
      ) : null}

      {phase === "pick" && !error ? (
        <section className="absolute inset-x-3 bottom-3 z-20 max-h-[68%] overflow-auto rounded-2xl bg-paper p-5 text-ink md:inset-y-6 md:right-auto md:left-6 md:w-96 md:max-h-none">
          <p className="text-xs font-semibold tracking-widest text-brick uppercase">
            Województwo małopolskie · 32-660
          </p>
          <h1 className="mt-1 font-display text-5xl leading-none">Chełmek</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Wybierz postać i wejdź na Plac Jana Kilińskiego. Układ ulic, obrysy budynków i Przemsza są w skali
            miasta — złożone z planu OpenStreetMap, nie ze skanu Google Earth.
          </p>
          <div className="mt-4 grid gap-2">
            {AVATAR_META.map((person) => {
              const on = avatar === person.id;
              return (
                <button
                  key={person.id}
                  type="button"
                  onClick={() => choose(person.id)}
                  className={
                    "flex items-center gap-3 rounded-2xl border px-3 py-3 text-left " +
                    (on ? "border-brick bg-paper-2" : "border-line bg-paper")
                  }
                >
                  <span className={`h-12 w-3 shrink-0 rounded-full ${ACCENT[person.id]}`} />
                  <span>
                    <span className="block font-display text-2xl leading-none">{person.name}</span>
                    <span className="mt-1 block text-sm text-muted">
                      {person.line}. {person.blurb}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={enterTown}
            className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brick px-4 font-semibold text-paper"
          >
            <Footprints className="size-5" />
            Wejdź na plac
          </button>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            W i S idą naprzód i wstecz, A skręca w lewo, D w prawo. Shift to bieg; na telefonie użyj drążka.
            W grze zmienisz jakość obrazu między Auto, Płynnie i Detale — bez pobierania dodatkowych plików.
          </p>
        </section>
      ) : null}

      {phase === "walk" && !error ? (
        <>
          <header className="pointer-events-none absolute top-3 left-3 z-10 mr-40 max-w-56 rounded-2xl bg-paper/95 px-4 py-3 text-ink sm:max-w-sm">
            <p className="text-xs font-semibold tracking-widest text-brick uppercase">Chełmek · 32-660</p>
            <h1 className="font-display text-2xl leading-tight">{street}</h1>
            <p className="mt-1 flex items-center gap-3 text-xs text-muted">
              <span className="inline-flex items-center gap-1">
                <Compass className="size-3.5" />
                {heading}
              </span>
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3.5" />
                {foundCount}/{landmarks.length || 0}
              </span>
            </p>
          </header>

          {near ? (
            <div className="pointer-events-none absolute top-28 right-3 left-3 z-10 mx-auto w-full max-w-sm rounded-2xl bg-ink/90 px-4 py-3 text-paper md:top-auto md:bottom-6 md:left-6 md:mx-0">
              <p className="text-xs font-semibold tracking-widest text-gold uppercase">
                {kindLabel(near.kind, near.name)}
              </p>
              <p className="mt-1 font-display text-xl leading-tight">{near.name}</p>
            </div>
          ) : null}

          <div className="absolute right-3 bottom-3 z-10 flex flex-col items-end gap-2">
            <button
              type="button"
              onClick={() => setGfx(handleRef.current?.cycleGfx() ?? "Auto")}
              title="Przełącz Auto, Płynnie lub Detale"
              aria-label={`Jakość grafiki: ${gfx}. Zmień ustawienie`}
              className="flex h-11 items-center gap-2 rounded-full border border-paper/25 bg-ink/80 px-4 text-sm font-semibold text-paper shadow-lg backdrop-blur-md transition hover:-translate-y-0.5 hover:bg-ink"
            >
              <Sparkles className="size-4 text-gold" />
              Grafika · {gfx}
            </button>
            <button
              type="button"
              onClick={() => setSound(handleRef.current?.toggleSound() ?? false)}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-paper text-ink"
              aria-label={sound ? "Wyłącz dźwięk" : "Włącz szum miasta"}
            >
              {sound ? <Volume2 className="size-5" /> : <VolumeX className="size-5" />}
            </button>
            <button
              type="button"
              onClick={() => setJournal((v) => !v)}
              className="flex h-11 items-center gap-2 rounded-full bg-paper px-4 text-sm font-semibold text-ink"
            >
              <BookOpen className="size-4" />
              Miejsca
            </button>
            <button
              type="button"
              onClick={() => handleRef.current?.returnToSquare()}
              className="flex h-11 items-center gap-2 rounded-full bg-paper px-4 text-sm font-semibold text-ink"
            >
              <RotateCcw className="size-4" />
              Na plac
            </button>
            <button
              type="button"
              onClick={backToPeople}
              className="flex h-11 items-center gap-2 rounded-full bg-pine px-4 text-sm font-semibold text-paper"
            >
              Zmień postać
            </button>
          </div>

          <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 hidden -translate-x-1/2 rounded-full bg-paper/90 px-4 py-2 text-xs text-muted md:block">
            W naprzód · S wstecz · A lewo · D prawo · Shift bieg
          </div>

          <div
            className="absolute bottom-28 left-4 z-10 h-28 w-28 touch-none rounded-full border border-line bg-paper/80 md:hidden"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              const rect = event.currentTarget.getBoundingClientRect();
              stickOrigin.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const dx = event.clientX - stickOrigin.current.x;
              const dy = event.clientY - stickOrigin.current.y;
              const max = 40;
              const len = Math.hypot(dx, dy) || 1;
              const scale = Math.min(1, max / len);
              const x = dx * scale;
              const y = dy * scale;
              setKnob({ x, y });
              handleRef.current?.setTouch(
                Math.max(-1, Math.min(1, -x / max)),
                Math.max(-1, Math.min(1, -y / max)),
              );
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              setKnob({ x: 0, y: 0 });
              handleRef.current?.setTouch(0, 0);
            }}
            onPointerCancel={() => {
              setKnob({ x: 0, y: 0 });
              handleRef.current?.setTouch(0, 0);
            }}
          >
            <span
              className="absolute top-1/2 left-1/2 h-12 w-12 rounded-full bg-brick"
              style={{ transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))` }}
            />
          </div>
          <button
            type="button"
            className={
              "absolute right-4 bottom-48 z-10 h-14 rounded-full px-5 text-sm font-semibold md:hidden " +
              (running ? "bg-brick text-paper" : "bg-paper text-ink")
            }
            onPointerDown={() => {
              setRunning(true);
              handleRef.current?.setRun(true);
            }}
            onPointerUp={() => {
              setRunning(false);
              handleRef.current?.setRun(false);
            }}
            onPointerLeave={() => {
              setRunning(false);
              handleRef.current?.setRun(false);
            }}
          >
            Bieg
          </button>

          {journal ? (
            <aside className="absolute inset-x-3 top-24 bottom-24 z-20 overflow-auto rounded-2xl bg-paper p-4 text-ink sm:inset-x-auto sm:right-3 sm:w-80">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-display text-2xl">Miejsca</h2>
                <button type="button" className="text-sm font-semibold text-brick" onClick={() => setJournal(false)}>
                  Zamknij
                </button>
              </div>
              <ul className="mt-3 grid gap-2">
                {landmarks.map((mark) => {
                  const seen = found.has(mark.id);
                  return (
                    <li
                      key={mark.id}
                      className={
                        "rounded-xl border px-3 py-2 " + (seen ? "border-line bg-paper-2" : "border-line opacity-70")
                      }
                    >
                      <p className="text-xs font-semibold tracking-wide text-brick uppercase">
                        {kindLabel(mark.kind, mark.name)}
                        {seen ? " · odwiedzone" : ""}
                      </p>
                      <p className="text-sm leading-snug">{mark.name}</p>
                    </li>
                  );
                })}
              </ul>
            </aside>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
