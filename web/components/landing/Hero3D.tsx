"use client";
import { useEffect, useRef } from "react";
type Three = typeof import("three");

/** Floating labelled spheres (reference: C8VN hero). Labels are Copas concepts and live markets, nothing decorative-fake. */
const LABELS = ["BOND", "MANDATE", "SLASH", "BTC", "ETH", "MON", "SOL", "CLAIM", "COPY"];
const RED = new Set(["SLASH", "BOND", "CLAIM"]);

function sphereTexture(THREE: Three, label: string, red: boolean, lite: boolean) {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 512;
  const g = c.getContext("2d")!;
  if (lite) {
    // half-size texture on phones: same drawing, a quarter of the pixels to fill and upload
    c.width = 512;
    c.height = 256;
    g.scale(0.5, 0.5);
  }
  g.fillStyle = red ? "#8f0d08" : "#17110f";
  g.fillRect(0, 0, 1024, 512);
  // dimples: the perforated look of the reference spheres
  g.fillStyle = red ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.07)";
  for (let y = 12; y < 512; y += 22)
    for (let x = (y / 22) % 2 ? 12 : 23; x < 1024; x += 22) {
      g.beginPath();
      g.arc(x, y, 3.2, 0, 7);
      g.fill();
    }
  // fit the label inside the visible front of the sphere (~1/3 of the wrapped texture width)
  let px = 150;
  do g.font = `600 ${px}px 'Barlow Condensed', 'Arial Narrow', sans-serif`;
  while (g.measureText(label).width > 1024 * 0.3 && (px -= 6) > 40);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = red ? "#ffffff" : "#e3241b";
  g.fillText(label, 512, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = lite ? 1 : 4;
  return t;
}

export function Hero3D() {
  const host = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = host.current!;
    const ov = overlay.current!;
    // three.js (~600 KB) loads after the page is interactive, never on the hydration path
    let stop: (() => void) | undefined;
    let dead = false;
    const idle = window.requestIdleCallback ?? ((f: () => void) => window.setTimeout(f, 200));
    const cancelIdle = window.cancelIdleCallback ?? window.clearTimeout;
    const id = idle(() =>
      import("three").then((THREE) => {
        if (!dead) stop = start(THREE, el, ov);
      }),
    );
    return () => {
      dead = true;
      cancelIdle(id);
      stop?.();
    };
  }, []);

  return (
    <div ref={host} className="absolute inset-0">
      <canvas ref={overlay} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />
    </div>
  );
}

function start(THREE: Three, el: HTMLDivElement, ov: HTMLCanvasElement) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // phones and low-core machines: no MSAA, lower pixel ratio, coarser spheres, half-size textures
  const lite = el.clientWidth < 640 || (navigator.hardwareConcurrency ?? 8) <= 4;
  const renderer = new THREE.WebGLRenderer({ antialias: !lite, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, lite ? 1.25 : 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  el.prepend(renderer.domElement);
  renderer.domElement.setAttribute("aria-hidden", "true");

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 0, 14);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x330000, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(4, 6, 8);
  scene.add(key);
  const rim = new THREE.PointLight(0xff2a1a, 22, 30);
  rim.position.set(-5, -2, 4);
  scene.add(rim);

  const group = new THREE.Group();
  scene.add(group);
  const geo = lite ? new THREE.SphereGeometry(1, 32, 24) : new THREE.SphereGeometry(1, 64, 48);
  const balls = LABELS.map((label, i) => {
    const map = sphereTexture(THREE, label, RED.has(label), lite);
    // the clearcoat shader is the slowest part of the first frame; phones get the standard one
    const mat = lite ? new THREE.MeshStandardMaterial({ map, roughness: 0.42, metalness: 0.1 }) : new THREE.MeshPhysicalMaterial({ map, roughness: 0.42, metalness: 0.1, clearcoat: 0.6, clearcoatRoughness: 0.35 });
    const m = new THREE.Mesh(geo, mat);
    const a = (i / LABELS.length) * Math.PI * 2;
    const r = 2.2 + (i % 3) * 0.9;
    const s = 0.75 + ((i * 37) % 10) / 22;
    m.scale.setScalar(s);
    m.userData = { base: new THREE.Vector3(Math.cos(a) * r * 0.9 - 2.2, Math.sin(a) * r * 0.55 + 0.9, ((i * 53) % 7) - 3.5), phase: i * 1.7, label };
    m.position.copy(m.userData.base);
    m.rotation.y = -Math.PI / 2 + (i % 2 ? 0.4 : -0.3);
    group.add(m);
    return m;
  });

  const size = () => {
    const w = el.clientWidth;
    const h = el.clientHeight;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    camera.aspect = w / h;
    camera.position.z = w < 640 ? 19 : 14;
    group.position.x = w < 640 ? 2 : 0; // the cluster sits left of centre on desktop; recentre it on phones
    camera.updateProjectionMatrix();
    ov.width = w * devicePixelRatio;
    ov.height = h * devicePixelRatio;
  };
  size();
  const ro = new ResizeObserver(() => {
    size();
    if (reduce) tick();
  });
  ro.observe(el);

  const mouse = { x: 0, y: 0 };
  const onMove = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    mouse.x = ((e.clientX - r.left) / r.width - 0.5) * 2;
    mouse.y = ((e.clientY - r.top) / r.height - 0.5) * 2;
  };
  el.addEventListener("pointermove", onMove);

  let visible = true;
  const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
  io.observe(el);

  const g2 = ov.getContext("2d")!;
  const v = new THREE.Vector3();
  const project = (m: InstanceType<Three["Mesh"]>) => {
    m.getWorldPosition(v);
    const d = v.distanceTo(camera.position);
    v.project(camera);
    const w = el.clientWidth;
    const h = el.clientHeight;
    const rad = (m.scale.x / (d * Math.tan((camera.fov * Math.PI) / 360))) * (h / 2);
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, r: rad };
  };
  const drawOverlay = () => {
    const k = devicePixelRatio;
    g2.setTransform(k, 0, 0, k, 0, 0);
    g2.clearRect(0, 0, ov.width, ov.height);
    const pts = balls.map(project);
    g2.lineWidth = 0.8;
    g2.strokeStyle = "rgba(255,255,255,0.8)";
    g2.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 3) % pts.length];
      g2.moveTo(a.x, a.y);
      g2.lineTo(b.x, b.y);
    }
    g2.stroke();
    g2.strokeStyle = "rgba(227,36,27,0.75)";
    g2.font = "10px ui-monospace, monospace";
    g2.fillStyle = "rgba(227,36,27,0.9)";
    pts.forEach((p, i) => {
      const s = p.r * 1.25;
      g2.strokeRect(p.x - s, p.y - s * 0.8, s * 2, s * 1.6);
      g2.fillText(String(i + 1).padStart(2, "0"), p.x - s + 3, p.y - s * 0.8 + 11);
    });
  };

  const clock = new THREE.Clock();
  let raf = 0;
  const tick = () => {
    if (!reduce) raf = requestAnimationFrame(tick); // reduced motion: draw one still frame (and again on resize)
    if (!visible) return;
    const t = reduce ? 0 : clock.getElapsedTime();
    for (const m of balls) {
      const { base, phase } = m.userData as { base: InstanceType<Three["Vector3"]>; phase: number };
      m.position.set(base.x + Math.sin(t * 0.35 + phase) * 0.25, base.y + Math.cos(t * 0.45 + phase) * 0.3, base.z);
      m.rotation.x = Math.sin(t * 0.2 + phase) * 0.25;
    }
    group.rotation.y += ((mouse.x * 0.35 - group.rotation.y) * 0.04) || 0;
    group.rotation.x += ((mouse.y * 0.2 - group.rotation.x) * 0.04) || 0;
    renderer.render(scene, camera);
    drawOverlay();
  };
  tick();

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    io.disconnect();
    el.removeEventListener("pointermove", onMove);
    balls.forEach((b) => {
      const mat = b.material as InstanceType<Three["MeshStandardMaterial"]>;
      mat.map?.dispose();
      mat.dispose();
    });
    geo.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
