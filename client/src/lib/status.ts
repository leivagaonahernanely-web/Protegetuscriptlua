export type BotStatusInput = {
  isLoading: boolean;
  isError: boolean;
  online?: boolean;
  state?: "online" | "connecting" | "offline" | "not_configured";
  username?: string | null;
};

export function getBotStatusLabel(status: BotStatusInput) {
  if (status.isLoading) return "BOT CONNECTING";
  if (status.isError) return "BOT STATUS UNAVAILABLE";
  if (status.online) return `BOT ONLINE · ${status.username || "Discord"}`;
  if (status.state === "connecting") return "BOT CONNECTING";
  if (status.state === "not_configured") return "BOT NOT CONFIGURED";
  return "BOT OFFLINE";
}

export function getBotStatusClass(status: BotStatusInput) {
  if (status.online) return "bot-online";
  if (status.isLoading || status.isError || status.state === "connecting") return "bot-connecting";
  return "bot-offline";
}
