/**
 * Generates src-tauri/resources/THIRD_PARTY_NOTICES.txt, the third-party notice that ships in the
 * installer next to the app (see bundle.resources in tauri.conf.json). The notice is not shown in
 * the UI; it is the carrier for the attribution obligations of the bundled dependencies.
 *
 * Sources, all read from the local machine so the script works offline:
 *   - src-tauri/Cargo.lock        -> Rust crates, metadata from the unpacked cargo registry source
 *   - package-lock.json           -> npm packages, metadata from node_modules
 *   - src-tauri/native/**         -> FFmpeg and TagLib, the bundled native libraries
 *
 * Run `npm run notices` after changing dependencies. A crate or package whose license text is not
 * present locally is still listed with its declared license expression, and the license ids that
 * ended up without a text are reported in the summary at the end of the generated file.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(root, "src-tauri", "resources", "THIRD_PARTY_NOTICES.txt");

const LICENSE_FILE = /^(LICENSE|LICENCE|COPYING|UNLICENSE|NOTICE)/i;

function readText(file) {
  try {
    return readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim();
  } catch {
    return "";
  }
}

function licenseFilesIn(directory) {
  if (!existsSync(directory)) return [];
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries
    .filter((name) => LICENSE_FILE.test(name))
    .filter((name) => {
      try {
        return statSync(path.join(directory, name)).isFile();
      } catch {
        return false;
      }
    })
    .sort()
    .map((name) => path.join(directory, name));
}

function concatLicenseText(directory) {
  const parts = licenseFilesIn(directory)
    .map(readText)
    .filter((text) => text.length > 0);
  return parts.join("\n\n");
}

/** `license = "MIT OR Apache-2.0"` from the crate manifest; falls back to license-file. */
function cargoLicenseExpression(manifestPath) {
  const manifest = readText(manifestPath);
  const expression = manifest.match(/^\s*license\s*=\s*"([^"]+)"/m);
  if (expression) return expression[1];
  const file = manifest.match(/^\s*license-file\s*=\s*"([^"]+)"/m);
  return file ? `see ${file[1]}` : "";
}

function splitLicenseIds(expression) {
  return expression
    .split(/\s+OR\s+/i)
    .flatMap((part) => part.split("/"))
    .map((part) => part.trim().replace(/^\(|\)$/g, ""))
    .filter((part) => part.length > 0 && !/^see /i.test(part));
}

function parseCargoLock() {
  const lock = readText(path.join(root, "src-tauri", "Cargo.lock"));
  const blocks = lock.split(/^\[\[package\]\]$/m).slice(1);
  return blocks
    .map((block) => {
      const name = block.match(/^name = "([^"]+)"/m)?.[1];
      const version = block.match(/^version = "([^"]+)"/m)?.[1];
      const source = block.match(/^source = "([^"]+)"/m)?.[1] ?? "";
      return name && version ? { name, version, source } : null;
    })
    .filter((entry) => entry && entry.name !== "Lyrico")
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function cargoRegistrySourceRoot() {
  const base = path.join(homedir(), ".cargo", "registry", "src");
  if (!existsSync(base)) return "";
  const candidate = readdirSync(base).find((entry) => statSync(path.join(base, entry)).isDirectory());
  return candidate ? path.join(base, candidate) : "";
}

function rustComponents() {
  const sourceRoot = cargoRegistrySourceRoot();
  return parseCargoLock().map(({ name, version, source }) => {
    const directory = sourceRoot ? path.join(sourceRoot, `${name}-${version}`) : "";
    const manifest = directory ? path.join(directory, "Cargo.toml") : "";
    const origin = source.startsWith("git+") ? "git" : "crates.io";
    return {
      name,
      version,
      origin,
      expression: manifest && existsSync(manifest) ? cargoLicenseExpression(manifest) : "",
      text: manifest && existsSync(manifest) ? concatLicenseText(directory) : "",
    };
  });
}

function npmComponents() {
  const lockPath = path.join(root, "package-lock.json");
  if (!existsSync(lockPath)) return [];
  const lock = JSON.parse(readText(lockPath));
  const components = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith("node_modules/")) continue;
    const name = entry.name ?? key.replace(/^node_modules\//, "");
    const directory = path.join(root, key);
    const manifest = path.join(directory, "package.json");
    let expression = entry.license ?? "";
    if (!expression && existsSync(manifest)) {
      try {
        expression = JSON.parse(readText(manifest)).license ?? "";
      } catch {
        expression = "";
      }
    }
    components.push({
      name,
      version: entry.version ?? "",
      origin: "npm",
      expression: typeof expression === "string" ? expression : "",
      text: concatLicenseText(directory),
    });
  }
  return components.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/**
 * The native libraries are built from the pinned submodules rather than a package registry, so they
 * are listed explicitly. FFmpeg is distributed as replaceable shared libraries; TagLib is compiled
 * into the binary, which is why its entry names the dual license and the chosen branch.
 */
function nativeComponents() {
  const ffmpeg = path.join(root, "src-tauri", "native", "ffmpeg");
  const taglib = path.join(root, "src-tauri", "native", "taglib", "upstream");
  const notice = readText(path.join(ffmpeg, "NOTICE.md"));
  const ffmpegSource = notice.match(/Source: (\S+)/)?.[1] ?? "https://ffmpeg.org/";
  return [
    {
      name: "FFmpeg",
      version: notice.match(/commit (\w+)/)?.[1] ?? "pinned submodule",
      origin: "bundled shared libraries (avcodec / avformat / avutil / swresample)",
      expression: "LGPL-2.1-or-later",
      text: [notice, readText(path.join(ffmpeg, "runtime", "COPYING.LGPLv2.1"))].filter(Boolean).join("\n\n"),
      extra: `Source: ${ffmpegSource}`,
    },
    {
      name: "TagLib",
      version: readText(path.join(taglib, "CHANGELOG.md")).match(/^TagLib ([0-9.]+)/)?.[1] ?? "pinned submodule",
      origin: "statically linked into the application binary",
      expression: "LGPL-2.1-only OR MPL-1.1",
      text: [readText(path.join(taglib, "COPYING.MPL")), readText(path.join(taglib, "COPYING.LGPL"))]
        .filter(Boolean)
        .join("\n\n"),
      extra: "Source: https://github.com/taglib/taglib",
    },
  ];
}

function textKey(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function render() {
  const components = [...nativeComponents(), ...npmComponents(), ...rustComponents()];

  // One canonical text per license id, harvested from whichever component ships it. Components
  // declaring `A OR B` contribute their text to both ids.
  const textById = new Map();
  const idsWithoutText = new Set();
  for (const component of components) {
    const ids = splitLicenseIds(component.expression);
    for (const id of ids) {
      if (component.text && !textById.has(id)) textById.set(id, component.text);
      if (!component.text && !textById.has(id)) idsWithoutText.add(id);
    }
  }
  for (const id of textById.keys()) idsWithoutText.delete(id);

  const section = (title, rows) => {
    const lines = rows.map((component) => {
      const version = component.version ? ` ${component.version}` : "";
      const license = component.expression || "license not declared";
      return `${component.name}${version}\n  License: ${license}\n  Origin:  ${component.origin}${component.extra ? `\n  ${component.extra}` : ""}`;
    });
    return `${"-".repeat(78)}\n${title}\n${"-".repeat(78)}\n\n${lines.join("\n\n")}\n`;
  };

  const texts = [...textById.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, text]) => `### ${id}  [${textKey(text)}]\n\n${text}\n`)
    .join("\n");

  return `THIRD-PARTY NOTICES
===================

Lyrico for Windows bundles the third-party components listed below. Each component remains under
its own license; nothing in this file changes those terms. Full license texts follow the component
list. Generated by scripts/generate-third-party-notices.mjs - run \`npm run notices\` to refresh it
after a dependency change.

FFmpeg is bundled as replaceable shared libraries (DLLs) under the GNU Lesser General Public
License, version 2.1 or later. TagLib is compiled into the application; it is used under the
Mozilla Public License 1.1, and its source is available from the project link below.

${section(`BUNDLED NATIVE LIBRARIES`, components.slice(0, 2))}
${section(`NPM PACKAGES (${npmComponents().length})`, components.slice(2, 2 + npmComponents().length))}
${section(`RUST CRATES (${rustComponents().length})`, components.slice(2 + npmComponents().length))}
${"-".repeat(78)}
LICENSE TEXTS (${textById.size})
${"-".repeat(78)}

${texts}
${idsWithoutText.size > 0 ? `\nLICENSE IDS WITHOUT A BUNDLED TEXT: ${[...idsWithoutText].sort().join(", ")}\n` : ""}`;
}

const output = render();
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, output, "utf8");
const lines = output.split("\n").length;
console.log(`wrote ${path.relative(root, outputPath)} (${lines} lines, ${(Buffer.byteLength(output) / 1024).toFixed(0)} KiB)`);
