// Points the Download buttons at the installer for the visitor's computer, taken from the
// latest published GitHub release. Until there is one, or on phones, they keep linking to the
// releases page.

export const REPO = "adamouks/theoremis";
export const RELEASES = `https://github.com/${REPO}/releases`;

type Target = "mac-arm" | "mac-intel" | "windows" | "linux";

interface Asset {
  name: string;
  browser_download_url: string;
}

const LABELS: Record<Target, string> = {
  "mac-arm": "macOS",
  "mac-intel": "macOS",
  windows: "Windows",
  linux: "Linux",
};

/** The logo symbols in index.html's sprite. */
const LOGOS: Record<Target, string> = {
  "mac-arm": "logo-apple",
  "mac-intel": "logo-apple",
  windows: "logo-windows",
  linux: "logo-linux",
};

/** Installer names produced by the release workflow, most preferred first. */
const INSTALLERS: Record<Target, RegExp[]> = {
  "mac-arm": [/_aarch64\.dmg$/i],
  "mac-intel": [/_x64\.dmg$/i],
  windows: [/_x64-setup\.exe$/i, /\.msi$/i],
  linux: [/\.AppImage$/i, /\.deb$/i],
};

interface UAData {
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
}

async function detect(): Promise<Target | null> {
  const ua = navigator.userAgent;
  const data = (navigator as Navigator & { userAgentData?: UAData }).userAgentData;
  const platform = `${data?.platform ?? ""} ${navigator.platform ?? ""} ${ua}`;
  // Phones and tablets have no desktop installer; iPads describe themselves as Macs.
  if (/iPhone|iPad|iPod|Android/i.test(ua) || (/Mac/.test(platform) && navigator.maxTouchPoints > 1)) {
    return null;
  }
  if (/Win/i.test(platform)) return "windows";
  if (/Mac/i.test(platform)) return (await isIntelMac(data)) ? "mac-intel" : "mac-arm";
  if (/Linux|X11|CrOS/i.test(platform)) return "linux";
  return null;
}

/** Browsers report every Mac as Intel, so look closer; most Macs today are Apple silicon. */
async function isIntelMac(data: UAData | undefined): Promise<boolean> {
  try {
    const { architecture } = (await data?.getHighEntropyValues?.(["architecture"])) ?? {};
    if (architecture) return architecture === "x86";
  } catch {
    // Not offered by this browser.
  }
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const renderer = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    if (/Apple (M\d|GPU)/i.test(renderer)) return false;
    if (/Intel|AMD|Radeon/i.test(renderer)) return true;
  } catch {
    // WebGL unavailable.
  }
  return false;
}

function logo(target: Target): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "download-os");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", `#${LOGOS[target]}`);
  svg.append(use);
  return svg;
}

export async function setUpDownloads() {
  const links = document.querySelectorAll<HTMLAnchorElement>("[data-download]");
  if (links.length === 0) return;
  const target = await detect();
  if (!target) return;

  let assets: Asset[];
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) return;
    assets = ((await response.json()) as { assets?: Asset[] }).assets ?? [];
  } catch {
    return;
  }
  const asset = INSTALLERS[target]
    .map((pattern) => assets.find((a) => pattern.test(a.name)))
    .find(Boolean);
  if (!asset) return;

  for (const link of links) {
    link.href = asset.browser_download_url;
    link.removeAttribute("target");
    link.title = asset.name;
    const label = link.querySelector("[data-download-label]");
    if (!label) continue;
    label.textContent = `Download for ${LABELS[target]}`;
    label.before(logo(target));
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-download-other]")) el.hidden = false;
}
