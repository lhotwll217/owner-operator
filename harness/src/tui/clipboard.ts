// Owner Operator — read an image off the clipboard for pasting screenshots into the chat (Ctrl+V).
// We reuse pi's OWN clipboard reader — the native, cross-platform one its `app.clipboard.pasteImage`
// (Ctrl+V) binding uses — instead of reinventing it. It isn't in the package's public `exports`, so
// we resolve the package main and import the sibling module by file URL (file URLs bypass the
// exports restriction). Falls back to `osascript` on macOS if that import ever fails.

import { spawn } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Base64 image + mime, ready for pi's `ImageContent` ({ type:"image", data, mimeType }). */
export interface ClipImage { data: string; mimeType: string }

// ---- pi's native reader (preferred) ------------------------------------------------------
type PiReader = () => Promise<{ bytes: Uint8Array; mimeType: string } | null>;
let piReader: PiReader | null | undefined; // undefined = not yet resolved
async function loadPiReader(): Promise<PiReader | null> {
  if (piReader !== undefined) return piReader;
  try {
    const resolve = (import.meta as { resolve?: (s: string) => string | Promise<string> }).resolve;
    if (!resolve) { piReader = null; return null; }
    const mainUrl = await resolve("@earendil-works/pi-coding-agent");
    const mod = await import(new URL("./utils/clipboard-image.js", mainUrl).href) as { readClipboardImage?: PiReader };
    piReader = typeof mod.readClipboardImage === "function" ? mod.readClipboardImage : null;
  } catch { piReader = null; }
  return piReader;
}

// ---- osascript fallback (macOS PNG, if pi's reader is ever unavailable) -------------------
function osascriptPng(): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const tmp = join(tmpdir(), `oo-clip-${process.pid}-${Date.now()}.png`);
    try {
      const p = spawn("osascript", [
        "-e", "try",
        "-e", "set d to (the clipboard as «class PNGf»)",
        "-e", `set f to open for access (POSIX file ${JSON.stringify(tmp)}) with write permission`,
        "-e", "set eof f to 0", "-e", "write d to f", "-e", "close access f",
        "-e", 'return "ok"', "-e", "on error", "-e", 'return "none"', "-e", "end try",
      ]);
      let out = "";
      p.on("error", () => resolve(null));
      p.stdout.on("data", (d: Buffer) => { out += d; });
      p.on("close", () => {
        if (out.trim() !== "ok") { resolve(null); return; }
        try { const b = readFileSync(tmp); resolve(b.length ? b : null); }
        catch { resolve(null); }
        finally { try { unlinkSync(tmp); } catch { /* best-effort cleanup */ } }
      });
    } catch { resolve(null); }
  });
}

/** The clipboard image as base64 + mime, or null if the clipboard holds no image. */
export async function readClipboardImage(): Promise<ClipImage | null> {
  const reader = await loadPiReader();
  if (reader) {
    try {
      const img = await reader();
      if (img?.bytes?.length) return { data: Buffer.from(img.bytes).toString("base64"), mimeType: img.mimeType };
    } catch { /* fall through to the osascript fallback */ }
  }
  if (process.platform === "darwin") {
    const png = await osascriptPng();
    if (png) return { data: png.toString("base64"), mimeType: "image/png" };
  }
  return null;
}
