// Demo video pipeline: VO (edge-tts) -> Playwright screen recording (CDP screencast) -> ffmpeg (fit to VO, burn subs) -> concat.
//   node video/make.mjs <name> [--only id1,id2] [--rerecord] [--norecord]
// Scene file video/scenes/<name>.mjs exports { mobile?, scenes: [{ id, vo, prep?, run? , frames?: "<video>/<id>" }] }.
// Outputs in video/out/<name>.mp4, work files in video/out/work/<name>/<id>/.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, "../web/package.json"));
const { chromium } = require("@playwright/test");

const [name, ...argv] = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i < 0 ? undefined : argv[i + 1] ?? true; };
const only = opt("--only")?.split(",");
const { default: spec } = await import(`./scenes/${name}.mjs`);
const WORK = path.join(HERE, "out/work", name);
const dirOf = (id) => path.join(HERE, "out/work", id.includes("/") ? id : `${name}/${id}`);
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString();
const probe = (f) => Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. VO per scene (cached on text)
for (const s of spec.scenes) {
  const d = dirOf(s.id);
  fs.mkdirSync(d, { recursive: true });
  const txt = path.join(d, "vo.txt");
  if (fs.existsSync(txt) && fs.readFileSync(txt, "utf8") === s.vo && fs.existsSync(path.join(d, "vo.json"))) continue;
  fs.writeFileSync(txt, s.vo);
  run("python", [path.join(HERE, "tts.py"), txt, path.join(d, "vo.mp3"), path.join(d, "vo.json")]);
}
for (const s of spec.scenes) s.dur = probe(path.join(dirOf(s.id), "vo.mp3"));
console.log(spec.scenes.map((s) => `${s.id} ${s.dur.toFixed(1)}s`).join("\n"), "\ntotal VO", spec.scenes.reduce((a, s) => a + s.dur + 0.5, 0).toFixed(1));

// 2. record
const needRec = spec.scenes.filter((s) => !s.frames && (s.run || s.prep) && (!only || only.includes(s.id)) && (argv.includes("--rerecord") || !fs.existsSync(path.join(dirOf(s.id), "frames/list.txt"))));
if (needRec.length && !argv.includes("--norecord")) {
  const m = spec.mobile;
  // screencast frames come at DIP size unless the browser itself is forced to the scale factor
  const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--hide-scrollbars", "--disable-blink-features=AutomationControlled", `--force-device-scale-factor=${m ? 2 : 1.2}`] });
  const context = await browser.newContext(m
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36", baseURL: BASE() }
    : { viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2, baseURL: BASE(), // explorers sit behind Cloudflare, which turns away "HeadlessChrome"
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" });
  await context.addInitScript(CURSOR, !!m);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const ctx = makeCtx(page, cdp, context);
  if (spec.setup) await spec.setup(ctx);
  for (const s of spec.scenes) {
    if (s.frames) continue;
    const want = needRec.includes(s);
    // scenes before a wanted one still run (unrecorded) when the flow is stateful (mobile passkey session)
    if (!want && !spec.stateful) continue;
    console.log(`> ${s.id}${want ? "" : " (unrecorded)"}`);
    ctx.dur = s.dur;
    if (s.prep) await s.prep(ctx);
    const fdir = path.join(dirOf(s.id), "frames");
    if (want) { fs.rmSync(fdir, { recursive: true, force: true }); fs.mkdirSync(fdir, { recursive: true }); }
    const frames = [];
    const onFrame = (f) => {
      cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      const file = `${String(frames.length).padStart(5, "0")}.jpg`;
      fs.writeFileSync(path.join(fdir, file), Buffer.from(f.data, "base64"));
      frames.push([file, Date.now()]);
    };
    if (want) {
      cdp.on("Page.screencastFrame", onFrame);
      await cdp.send("Page.startScreencast", m ? { format: "jpeg", quality: 92, maxWidth: 780, maxHeight: 1688 } : { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080 });
    }
    const t0 = Date.now();
    ctx.t0 = t0;
    if (s.run) await s.run(ctx);
    const left = t0 + (s.dur + 0.5) * 1000 - Date.now();
    if (left > 0) await sleep(left);
    if (!want) continue;
    // nudge one last frame so the hold is captured
    await page.evaluate(() => document.body.style.setProperty("--copas-nudge", String(Math.random())));
    await sleep(150);
    await cdp.send("Page.stopScreencast");
    cdp.off("Page.screencastFrame", onFrame);
    const end = Date.now();
    if (!frames.length) throw new Error(`no frames for ${s.id}`);
    const lines = frames.map(([f, t], i) => `file '${f}'\nduration ${(((frames[i + 1]?.[1] ?? end) - Math.max(t, t0)) / 1000).toFixed(3)}`);
    fs.writeFileSync(path.join(fdir, "list.txt"), `ffconcat version 1.0\n${lines.join("\n")}\nfile '${frames.at(-1)[0]}'\n`);
    console.log(`  ${((end - t0) / 1000).toFixed(1)}s recorded vs ${s.dur.toFixed(1)}s VO`);
  }
  await browser.close();
}

// 3. encode each scene: fit video to VO (+0.5 s), burn subtitles
const STYLE = "FontName=Segoe UI Semibold,FontSize=13,PrimaryColour=&H00FFFFFF,BorderStyle=3,OutlineColour=&H90000000,BackColour=&H90000000,Outline=7,Shadow=0,MarginV=22,MarginL=60,MarginR=60";
const clips = [];
for (const s of spec.scenes) {
  const d = dirOf(s.id);
  const fsrc = path.join(dirOf(s.frames ?? s.id), "frames");
  const T = s.dur + 0.5;
  const out = path.join(WORK, `${s.id.replaceAll("/", "_")}.mp4`);
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(WORK, `${s.id.replaceAll("/", "_")}.srt`), srt(JSON.parse(fs.readFileSync(path.join(d, "vo.json"), "utf8")).words, s.vo));
  const L = probeFrames(path.join(fsrc, "list.txt"));
  const speed = L > T + 0.4 ? T / L : 1;
  if (speed < 1) console.log(`  ${s.id}: speed x${(1 / speed).toFixed(2)}`);
  const [w, h] = imgSize(path.join(fsrc, "00000.jpg"));
  const fit = h > w
    ? `scale=-2:900,pad=1920:1080:(ow-iw)/2:24:color=0x0d1117,drawbox=x=${(1920 - pw(w, h)) / 2 - 3}:y=21:w=${pw(w, h) + 6}:h=906:color=0x30363d:t=3`
    : `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0d1117`;
  const vf = `setpts=PTS*${speed.toFixed(4)},fps=30,${fit},tpad=stop_mode=clone:stop_duration=${T},subtitles=${s.id.replaceAll("/", "_")}.srt:force_style='${STYLE}',format=yuv420p`;
  run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", path.join(fsrc, "list.txt"), "-i", path.join(d, "vo.mp3"),
    "-filter_complex", `[0:v]${vf}[v];[1:a]aresample=48000,apad=whole_dur=${T}[a]`, "-map", "[v]", "-map", "[a]", "-t", T.toFixed(3),
    "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-r", "30", "-c:a", "aac", "-b:a", "160k", "-ac", "2", out], WORK);
  clips.push(out);
}
const list = path.join(WORK, "concat.txt");
fs.writeFileSync(list, clips.map((c) => `file '${c.replaceAll("\\", "/")}'`).join("\n"));
const final = path.join(HERE, "out", `${name}.mp4`);
run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", final]);
console.log(`${final} ${probe(final).toFixed(1)}s`);

function BASE() { return process.env.BASE_URL || "https://copas-mocha.vercel.app"; }

/** phone width after scale=-2:900 */
function pw(w, h) { return Math.round((w * 900) / h / 2) * 2; }
function probeFrames(list) {
  return fs.readFileSync(list, "utf8").split("\n").filter((l) => l.startsWith("duration")).reduce((a, l) => a + Number(l.split(" ")[1]), 0);
}
function imgSize(f) {
  const [w, h] = run("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height", "-of", "csv=p=0", f]).trim().split(",").map(Number);
  return [w, h];
}

/** Word timings -> cues of <= ~58 chars, broken at sentence ends; text taken from the original VO so punctuation survives. */
function srt(words, text) {
  let pos = 0;
  const toks = words.map(([a, b, w]) => {
    const i = text.toLowerCase().indexOf(w.toLowerCase(), pos);
    if (i < 0) return null;
    const end = i + w.length;
    const start = pos;
    pos = end;
    return { a, b, start, end };
  }).filter(Boolean);
  const cues = [];
  let cur = null;
  for (const t of toks) {
    if (!cur) cur = { a: t.a, b: t.b, start: t.start, end: t.end };
    else { cur.b = t.b; cur.end = t.end; }
    const after = text.slice(t.end, t.end + 2);
    const len = text.slice(cur.start, cur.end).trim().length;
    if (/^[.?!:]/.test(after) || len > 52 || (/^[,;]/.test(after) && len > 30)) { cur.end = t.end + (/^[.?!,;:]/.test(after) ? 1 : 0); cues.push(cur); cur = null; }
  }
  if (cur) { cur.end = text.length; cues.push(cur); }
  const ts = (s) => new Date(Math.max(0, s) * 1000).toISOString().slice(11, 23).replace(".", ",");
  return cues.map((c, i) => `${i + 1}\n${ts(c.a)} --> ${ts(Math.max(c.b, (cues[i + 1]?.a ?? c.b + 0.6) - 0.05))}\n${text.slice(c.start, c.end).trim().replace(/^[,.;:?!]\s*/, "")}\n`).join("\n");
}

function makeCtx(page, cdp, context) {
  const ctx = {
    page, cdp, context,
    sleep,
    async goto(url, waitFor) {
      await page.goto(url, { waitUntil: "load", timeout: 90_000 });
      if (waitFor) await page.getByText(waitFor).first().waitFor({ timeout: 60_000 }).catch(() => console.log(`  (no "${waitFor}")`));
      await sleep(800);
    },
    /** explorer tx page, waited until the details render (monadscan; needs the non-headless user agent set on the context) */
    async tx(hash) {
      await page.goto(`https://testnet.monadscan.com/tx/${hash}`, { waitUntil: "load", timeout: 90_000 });
      await page.getByText(/Success/).first().waitFor({ timeout: 30_000 }).catch(() => console.log(`  (tx ${hash} not rendered)`));
      await sleep(1500);
    },
    pos: { x: 800, y: 450 },
    async move(target, ms = 700) {
      let x, y;
      if (Array.isArray(target)) [x, y] = target;
      else {
        const loc = typeof target === "string" ? page.getByText(target).first() : target;
        await loc.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {});
        const b = await loc.boundingBox().catch(() => null);
        if (!b) { console.log(`  (cannot find ${target})`); return; }
        x = b.x + b.width / 2; y = b.y + b.height / 2;
      }
      const steps = Math.max(8, Math.round(ms / 16));
      const { x: x0, y: y0 } = ctx.pos;
      for (let i = 1; i <= steps; i++) {
        const k = i / steps, e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        await page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
        await sleep(ms / steps / 2);
      }
      ctx.pos = { x, y };
    },
    async click(target) {
      await ctx.move(target);
      if (Array.isArray(target)) { await page.mouse.down(); await sleep(80); await page.mouse.up(); }
      else await (typeof target === "string" ? page.getByText(target).first() : target).click().catch((e) => console.log(`  click failed: ${e.message.slice(0, 120)}`));
      await sleep(300);
    },
    /** gentle scroll by px over ms */
    async scroll(px, ms = 1500) {
      const steps = Math.max(10, Math.round(ms / 25));
      for (let i = 0; i < steps; i++) { await page.evaluate((d) => window.scrollBy(0, d), px / steps); await sleep(ms / steps); }
    },
    /** scroll so the element's top sits ~120px below the viewport top */
    async scrollTo(target, ms = 1500) {
      const loc = typeof target === "string" ? page.getByText(target).first() : target;
      const b = await loc.boundingBox().catch(() => null);
      if (!b) { console.log(`  (cannot scroll to ${target})`); return; }
      await ctx.scroll(b.y - 120, ms);
    },
    /** wait until t seconds into the scene */
    async at(t) { const l = ctx.t0 + t * 1000 - Date.now(); if (l > 0) await sleep(l); },
    /** terminal page: types each `cmd`, then prints its real captured `out` line by line; resolves when done */
    async term(blocks, title = "bash") {
      await page.goto("about:blank");
      await page.setContent(`<!doctype html><html><head><style>
        html,body{margin:0;height:100%;background:#0d1117}
        .w{position:absolute;inset:28px 40px 130px;border:1px solid #30363d;border-radius:10px;background:#010409;display:flex;flex-direction:column;overflow:hidden}
        .bar{height:34px;background:#161b22;display:flex;align-items:center;padding:0 14px;gap:8px;color:#8b949e;font:15px "Segoe UI",sans-serif}
        .d{width:12px;height:12px;border-radius:50%}
        pre{margin:0;padding:18px 22px;flex:1;overflow:hidden;color:#e6edf3;font:19px/1.42 "Cascadia Mono",Consolas,monospace;white-space:pre-wrap;word-break:break-all}
        .p{color:#3fb950}.c{color:#f0b429}.e{color:#ff7b72}.t{color:#79c0ff}</style></head>
        <body><div class="w"><div class="bar"><span class="d" style="background:#ff5f56"></span><span class="d" style="background:#ffbd2e"></span><span class="d" style="background:#27c93f"></span>&nbsp;${title}</div><pre id="o"></pre></div></body></html>`);
      await page.evaluate(async (blocks) => {
        const o = document.getElementById("o");
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const span = (cls, txt) => { const s = document.createElement("span"); s.className = cls; s.textContent = txt; o.appendChild(s); o.scrollTop = o.scrollHeight; return s; };
        for (const b of blocks) {
          span("p", "$ ");
          const c = span("c", "");
          for (const ch of b.cmd) { c.textContent += ch; await wait(28); }
          span("", "\n");
          await wait(b.pause ?? 500);
          const lines = b.out.replace(/\s+$/, "").split("\n");
          const per = Math.max(4, Math.min(60, (b.outMs ?? 1500) / lines.length));
          for (const l of lines) { span(/"ok": false|"code"|error/i.test(l) ? "e" : /^\[tx\]/.test(l) ? "t" : "", l + "\n"); await wait(per); }
          span("", "\n");
          await wait(b.after ?? 600);
        }
      }, blocks);
    },
    async card(html) {
      await page.goto("about:blank");
      await page.setContent(`<!doctype html><html><head><style>
        html,body{margin:0;height:100%;background:#0d1117;color:#e6edf3;font-family:"Segoe UI",system-ui,sans-serif}
        body{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 120px}
        .big{font-size:120px;font-weight:700;color:#f0b429;line-height:1}.t{font-size:44px;margin-top:28px;max-width:1100px;line-height:1.3}
        .s{font-size:24px;color:#8b949e;margin-top:24px}</style></head><body>${html}</body></html>`);
      await sleep(300);
    },
  };
  return ctx;
}

// fake cursor (headless has none); a touch dot on mobile
function CURSOR(mobile) {
  addEventListener("DOMContentLoaded", () => {
    const c = document.createElement("div");
    c.id = "copas-cursor";
    c.style.cssText = mobile
      ? "position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;background:rgba(120,120,120,.35);border:2px solid rgba(255,255,255,.8);z-index:2147483647;pointer-events:none;transition:transform .1s;opacity:0"
      : "position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transition:transform .1s";
    if (!mobile) c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l16 10.5-7 1.2 4 7.3-3 1.6-4-7.4L4 20z" fill="#111" stroke="#fff" stroke-width="1.6"/></svg>';
    document.documentElement.appendChild(c);
    const xy = JSON.parse(sessionStorage.getItem("copas-cursor") || "[800,450]");
    c.style.left = xy[0] + "px"; c.style.top = xy[1] + "px";
    addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; if (mobile) c.style.opacity = "1"; sessionStorage.setItem("copas-cursor", JSON.stringify([e.clientX, e.clientY])); }, true);
    addEventListener("mousedown", () => (c.style.transform = "scale(.8)"), true);
    addEventListener("mouseup", () => (c.style.transform = ""), true);
  });
}
