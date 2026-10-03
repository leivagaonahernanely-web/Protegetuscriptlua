import type { Express, Request, Response } from "express";
import { claimLicenseHwid, getActiveLicenseForHostedScript, getHostedScriptBySlug, getLicenseById, getHostedScriptById, isDiscordUserBlacklistedForScript } from "./db";
import { verifyLoaderToken } from "./loaderTokens";

function browserNotice(title: string, message: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Vanta.vs Protector</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#061a2d;color:#f3f6fa;font:15px system-ui,sans-serif}main{width:min(100%,540px);padding:42px 24px;border:1px solid #174568;border-radius:20px;background:#08213a;text-align:center;box-shadow:0 24px 70px #0007}.mark{width:42px;height:42px;display:grid;place-items:center;margin:0 auto 18px;border-radius:50%;background:#f5f7fa;color:#071a2d;font-weight:800}.eyebrow{color:#65baff;font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}h1{margin:12px 0 0;font-size:30px}p{color:#98b1c5;line-height:1.5}</style></head><body><main><div class="mark">&lt;/&gt;</div><div class="eyebrow">Vanta.vs Protector</div><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

export function registerHostingRoutes(app: Express) {
  app.get("/scripts/loaders/:token", async (req: Request, res: Response) => {
    const token = typeof req.params.token === "string" ? req.params.token : "";
    const match = /^(\d+)-([A-Za-z0-9_-]{24})\.lua$/.exec(token);
    if (!match) { res.status(404).type("text/plain").send("Loader not found"); return; }
    try {
      const license = await getLicenseById(Number(match[1]));
      if (!license || license.status !== "active" || !license.hostedScriptId || (license.expiresAt && license.expiresAt.getTime() <= Date.now()) || !verifyLoaderToken(token.replace(/^\d+-|\.lua$/g, ""), license.id, license.keyCode)) {
        res.status(404).type("text/plain").send("Loader not found"); return;
      }
      const script = await getHostedScriptById(license.hostedScriptId);
      if (!script) { res.status(404).type("text/plain").send("Loader not found"); return; }
      const endpoint = `${req.protocol}://${req.get("host")}/scripts/hosted/${script.slug}?key=${encodeURIComponent(license.keyCode)}`;
      const stageTwo = `local h = game:GetService("RbxAnalyticsService"):GetClientId()\nloadstring(game:HttpGet("${endpoint}&hwid=" .. h))()`;
      res.setHeader("Cache-Control", "private, no-store");
      res.type("text/plain; charset=utf-8").send(stageTwo);
    } catch (error) {
      console.error("[Hosting] Loader token failed", error);
      res.status(404).type("text/plain").send("Loader not found");
    }
  });
  app.get("/scripts/hosted/:slug", async (req: Request, res: Response) => {
    const slug = typeof req.params.slug === "string" ? req.params.slug : "";
    const acceptsHtml = typeof req.headers.accept === "string" && req.headers.accept.includes("text/html");
    if (!/^[A-Za-z0-9_-]{10,32}$/.test(slug)) {
      if (acceptsHtml) res.status(404).type("html").send(browserNotice("Script not found", "The hosted script does not exist or is no longer available."));
      else res.status(404).type("text/plain").send("Script not found");
      return;
    }
    try {
      const script = await getHostedScriptBySlug(slug);
      if (!script) {
        if (acceptsHtml) res.status(404).type("html").send(browserNotice("Script not found", "The hosted script does not exist or is no longer available."));
        else res.status(404).type("text/plain").send("Script not found");
        return;
      }
      const query = req.query ?? {};
      const requestedKey = typeof query.key === "string" ? query.key.trim() : typeof query.script_key === "string" ? query.script_key.trim() : "";
      const trialAccess = Boolean(script.ffaMode) && requestedKey === "trial";
      const requestedHwid = typeof req.headers["x-hwid"] === "string" ? req.headers["x-hwid"].trim() : typeof query.hwid === "string" ? query.hwid.trim() : "";
      const normalKeyPattern = /^(?:[a-z0-9]{32,64}|(?:FREE|PRO|PREMIUM)-[a-z0-9]{16})$/i;
      const hasValidKeyShape = Boolean(requestedKey && normalKeyPattern.test(requestedKey));
      const activeLicense = requestedKey ? await getActiveLicenseForHostedScript(script.id, requestedKey) : undefined;
      const blocked = Boolean(activeLicense?.discordUserId && await isDiscordUserBlacklistedForScript(activeLicense.ownerId, script.id, activeLicense.discordUserId));
      const protectedAccess = !script.ffaMode && !blocked && Boolean(requestedKey && requestedHwid && requestedHwid.length <= 128 && hasValidKeyShape && await claimLicenseHwid(script.id, requestedKey, requestedHwid));
      if (!trialAccess && !protectedAccess) {
        const message = blocked
          ? "Access blocked for this script"
          : script.ffaMode
          ? (requestedKey ? "La key trial no es válida." : "No key was provided")
          : (!requestedKey ? "No key was provided" : (!requestedHwid ? "HWID not compatible" : "HWID not compatible"));
        if (acceptsHtml) res.status(403).type("html").send(browserNotice("Key required", message));
        else {
          res.status(403).type("text/plain; charset=utf-8").send(`game:GetService("Players").LocalPlayer:Kick(${JSON.stringify(message)})`);
        }
        return;
      }
      res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");
      const loaderUrl = `${req.protocol}://${req.get("host")}/scripts/hosted/${script.slug}`;
      const runtimeKey = script.ffaMode ? "trial" : script.scriptKey;
      const accessUrl = runtimeKey ? `${loaderUrl}?key=${encodeURIComponent(runtimeKey)}` : loaderUrl;
      const load = script.ffaMode || !runtimeKey
        ? `loadstring(game:HttpGet("${accessUrl}"))()`
        : `local hwid = game:GetService("RbxAnalyticsService"):GetClientId()\nloadstring(game:HttpGet("${accessUrl}&hwid=" .. hwid))()`;
      const loader = runtimeKey ? `script_key = "${runtimeKey}"\n${load}` : load;
      if (acceptsHtml) {
        const safeName = script.name.replace(/[<>&\"]/g, "");
        const safeLoader = loader.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
        res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeName} · Vanta.vs Protector</title><style>*,*::before,*::after{box-sizing:border-box}body{margin:0;min-height:100vh;background:#061a2d;color:#f3f6fa;font:15px Inter,system-ui,sans-serif;display:grid;place-items:center;padding:24px;background-image:radial-gradient(circle at 50% 0,#0b3150 0,#061a2d 42%,#041323 100%)}main{width:min(100%,700px);padding:42px 24px 34px;border:1px solid #174568;border-radius:20px;background:#08213aee;box-shadow:0 24px 70px #0007;text-align:center}header{margin-bottom:30px}.mark{width:42px;height:42px;display:grid;place-items:center;margin:0 auto 18px;border-radius:50%;background:#f5f7fa;color:#071a2d;font-weight:800}.eyebrow{margin:0 0 12px;color:#65baff;font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}h1{margin:0;font-size:clamp(24px,5vw,36px);letter-spacing:-.04em}p{margin:11px 0 0;color:#98b1c5;line-height:1.55}.loader-box{margin-top:28px;padding:15px 16px;border:1px solid #1c5179;border-radius:9px;background:#03101cee;text-align:left;overflow:auto}label{display:block;margin-bottom:10px;color:#6da1c4;font-size:11px;font-weight:800;letter-spacing:.1em}code{display:block;color:#e7f1fb;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}.copy{width:100%;margin-top:12px;padding:12px;border:0;border-radius:8px;background:#08a9fa;color:#021522;font-weight:800;cursor:pointer}.copy:hover{background:#34baff}.hint{margin-top:18px;font-size:12px}.footer{margin-top:30px;color:#557590;font-size:11px}</style></head><body><main><header><div class="mark">&lt;/&gt;</div><p class="eyebrow">Vanta.vs Protector</p><h1>${safeName}</h1><p>This script can't be viewed in a browser.<br>For security, the protected source is delivered only at runtime.</p></header><section class="loader-box"><label>LOADER</label><code id="loader">${safeLoader}</code><button class="copy" onclick="navigator.clipboard.writeText(document.getElementById('loader').innerText);this.innerText='Copied'">Copy loader</button></section><p class="hint">Paste this into your executor — it will fetch and run the hosted script.</p><div class="footer">Protected runtime delivery · Vanta.vs</div></main></body></html>`);
      } else {
        res.type("text/plain; charset=utf-8").send(script.code);
      }
    } catch (error) {
      console.error("[Hosting] Public script failed", error);
      res.status(500).type("text/plain").send("Script unavailable");
    }
  });
}
