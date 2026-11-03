import { readFileSync } from "node:fs";
import path from "node:path";

// The booking app and staff screen are plain HTML files in public/, read once at start-up.
// The service runs from the repo root (the same place migrate.ts reads the .sql files from).
const read = (f: string) => readFileSync(path.resolve("public", f), "utf8");
export const bookPage = read("book.html");
export const staffPage = read("staff.html");
export const manifest = JSON.stringify({
  name: "On The Green", short_name: "OTG", start_url: "/book", display: "standalone",
  background_color: "#0f2a1d", theme_color: "#0f2a1d",
  icons: [
    { src: "/book/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/book/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/book/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
});
export const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#0f2a1d"/><circle cx="256" cy="300" r="120" fill="#f6f1e7"/><path d="M256 60v190" stroke="#c4a26a" stroke-width="18"/><path d="M256 64l110 40-110 40z" fill="#c4a26a"/></svg>`;

// The OTG logo as app icons (home screen) and a small header logo, read once at start-up.
const IMAGES = ["icon-180.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "logo-128.png"];
export const images: Record<string, Buffer> = Object.fromEntries(IMAGES.map((f) => [f, readFileSync(path.resolve("public", f))]));
