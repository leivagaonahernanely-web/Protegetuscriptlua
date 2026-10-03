import { ENV } from "./_core/env";

export type DiscordMessage = { title: string; content: string };

export async function getDiscordBotIdentity(): Promise<{ id: string; username: string } | null> {
  if (!ENV.discordBotToken) return null;
  try {
    const response = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bot ${ENV.discordBotToken}` }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return null;
    const body = await response.json() as { id?: string; username?: string };
    return body.id && body.username ? { id: body.id, username: body.username } : null;
  } catch (error) {
    console.warn("[Discord] Bot identity check failed:", error);
    return null;
  }
}

export type DiscordChannelCheck = { ok: true; channelId: string } | { ok: false; message: string; status?: number };

export async function checkDiscordChannel(channelId: string): Promise<DiscordChannelCheck> {
  if (!/^\d{15,22}$/.test(channelId)) return { ok: false, message: "El ID del canal debe tener entre 15 y 22 dígitos." };
  if (!ENV.discordBotToken) return { ok: false, message: "El bot de Discord no está configurado." };
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`https://discord.com/api/v10/channels/${channelId}`, { headers: { Authorization: `Bot ${ENV.discordBotToken}` }, signal: AbortSignal.timeout(attempt === 0 ? 8_000 : 4_000) });
      if (response.ok) return { ok: true, channelId };
      if (response.status === 401) return { ok: false, status: 401, message: "Discord rechazó el token del bot (HTTP 401). Revisa DISCORD_BOT_TOKEN en los secretos del proyecto." };
      if (response.status === 404) return { ok: false, status: 404, message: "Discord devolvió 404 para ese canal. Comprueba que el enlace sea del servidor correcto y que el bot esté instalado allí; no se puede confirmar otra causa desde este endpoint." };
      if (response.status === 403) return { ok: false, status: 403, message: "Discord devolvió 403 al consultar ese canal. Revisa View Channel y Send Messages para el bot, pero el panel no asumirá que esa sea la única causa." };
      return { ok: false, status: response.status, message: `Discord rechazó el canal (HTTP ${response.status}).` };
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
  const errorName = lastError instanceof Error ? lastError.name : "";
  if (errorName === "TimeoutError" || errorName === "AbortError") return { ok: false, message: "Discord tardó demasiado en responder. Inténtalo de nuevo en unos segundos." };
  return { ok: false, message: "No se pudo conectar con Discord desde el servidor. Comprueba la conectividad del bot e inténtalo de nuevo." };
}

export async function sendDiscordChannelMessage(channelId: string | undefined, message: DiscordMessage): Promise<boolean> {
  if (!channelId || !/^\d{15,22}$/.test(channelId) || !ENV.discordBotToken) return false;
  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${ENV.discordBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: `**${message.title}**\n${message.content}`.slice(0, 2000),
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      console.warn(`[Discord] Channel notification rejected (${response.status})`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[Discord] Channel notification failed:", error);
    return false;
  }
}
