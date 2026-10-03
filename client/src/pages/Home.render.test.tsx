// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAuth } from "@/_core/hooks/useAuth";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: vi.fn(() => ({
    user: { name: "Owner", email: "owner@example.com", role: "admin", isOwner: true, discordUsername: "Protectorscripts" },
    loading: false,
    isAuthenticated: true,
    logout: vi.fn(),
  })),
}));

vi.mock("@/const", () => ({ startLogin: vi.fn(), startDiscordLogin: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: { children: React.ReactNode }) => <button {...props}>{children}</button> }));
vi.mock("@/components/ui/input", () => ({ Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} /> }));
vi.mock("@/components/ui/textarea", () => ({ Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} /> }));
vi.mock("@/components/ui/switch", () => ({ Switch: ({ checked }: { checked?: boolean }) => <input type="checkbox" checked={checked} readOnly /> }));

const { pricesMutate, updatesMutate, trpcProxy } = vi.hoisted(() => {
  const pricesMutate = vi.fn();
  const updatesMutate = vi.fn();
  const queryResult = (data: unknown = []) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });
  const mutationResult = () => ({ mutate: vi.fn(), isPending: false });
  const makeProxy = (path: string[] = []): object => new Proxy({}, {
    get: (_target, key: string | symbol) => {
      const name = String(key);
      if (name === "useQuery") return () => path.join(".") === "discord.listPanels" ? queryResult([{ id: 1, name: "Panel principal", channelId: "123456789012345678" }]) : queryResult();
      if (name === "useMutation") {
        if (path.join(".") === "discord.publishPrices") return () => ({ mutate: pricesMutate, isPending: false });
        if (path.join(".") === "discord.publishUpdates") return () => ({ mutate: updatesMutate, isPending: false });
        return mutationResult;
      }
      return makeProxy([...path, name]);
    },
  });
  return { pricesMutate, updatesMutate, trpcProxy: makeProxy() };
});
vi.mock("@/lib/trpc", () => ({ trpc: trpcProxy }));

import Home, { friendlyApiError } from "./Home";

afterEach(() => {
  cleanup();
  vi.mocked(useAuth).mockImplementation(() => ({
    user: { name: "Owner", email: "owner@example.com", role: "admin", isOwner: true, discordUsername: "Protectorscripts" },
    loading: false,
    isAuthenticated: true,
    logout: vi.fn(),
  }) as never);
  pricesMutate.mockClear();
  updatesMutate.mockClear();
});

describe("Home authenticated dashboard render", () => {
  it("exposes Discord as the login provider on the unauthenticated entry", async () => {
    const auth = await import("@/_core/hooks/useAuth");
    vi.mocked(auth.useAuth).mockReturnValue({ user: null, loading: false, isAuthenticated: false, logout: vi.fn() } as never);
    render(<Home />);
    expect(screen.getByRole("heading", { name: "Inicia sesión con Discord" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Continuar con Discord/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Continuar con acceso/i })).toBeNull();
  });
  it("normalizes HTML API parse errors into an actionable message", () => {
    expect(friendlyApiError(new Error("Unexpected token '<', \"<html>\" is not valid JSON"), "fallback")).toContain("respuesta inválida");
    expect(friendlyApiError(new Error("El Gateway Discord no está conectado."), "fallback")).toBe("El Gateway Discord no está conectado.");
  });
  it("renders the Prices editor and submits its structured payload through tRPC", () => {
    render(<Home initialSection="Prices" />);
    fireEvent.change(screen.getByPlaceholderText("Nombre de tu script o marca"), { target: { value: "Vanta.vs APP" } });
    fireEvent.change(screen.getAllByPlaceholderText("Ej. Duels Script")[0], { target: { value: "Duels Script" } });
    fireEvent.change(screen.getAllByPlaceholderText("Una línea por plan o método de pago...")[0], { target: { value: "$7 USD" } });
    fireEvent.change(screen.getByPlaceholderText("ID del canal de Prices (15–22 dígitos)"), { target: { value: "123456789012345678" } });
    fireEvent.click(screen.getByRole("button", { name: /Publicar Prices/i }));
    expect(pricesMutate).toHaveBeenCalledWith(expect.objectContaining({ title: "Vanta.vs APP", channelId: "123456789012345678" }));
    expect(pricesMutate.mock.calls[0][0].description).toContain("**Duels Script**\n$7 USD");
    expect(pricesMutate.mock.calls[0][0].description).not.toContain("Premium Plan");
  });

  it("renders the Updates editor and submits its title and content through tRPC", () => {
    render(<Home initialSection="Updates" />);
    fireEvent.change(screen.getByPlaceholderText("Ej. Nueva versión disponible"), { target: { value: "Nueva versión" } });
    fireEvent.change(screen.getByPlaceholderText("Escribe los cambios, correcciones y avisos importantes..."), { target: { value: "Correcciones y mejoras." } });
    fireEvent.change(screen.getByPlaceholderText("ID del canal de Updates (15–22 dígitos)"), { target: { value: "123456789012345678" } });
    fireEvent.click(screen.getByRole("button", { name: /Publicar actualización/i }));
    expect(updatesMutate).toHaveBeenCalledWith({ title: "Nueva versión", description: "Correcciones y mejoras.", channelId: "123456789012345678" });
  });

  it("renders Plans with usage, plan cards and separated redeem area", () => {
    const html = renderToStaticMarkup(<Home initialSection="Plans" />);
    expect(html).toContain("Planes y beneficios");
    expect(html).toContain("Free Plan");
    expect(html).toContain("Pro Plan");
    expect(html).toContain("Premium Plan");
    expect(html).toContain("Activar plan");
    expect(html).not.toContain("Accepted Payments");
  });

  it("renders the informative Overview with one navigation entry per destination and bot status", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain("Workspace / Overview");
    expect(html).toContain("Vanta.vs Protector");
    expect(html).toContain("BOT OFFLINE");
    expect((html.match(/Generate \/ Manage/g) ?? []).length).toBe(1);
    expect((html.match(/Create New Panel/g) ?? []).length).toBe(1);
    expect((html.match(/Manage Panels/g) ?? []).length).toBe(1);
    expect(html).not.toContain("Coming Soon");
    expect(html).not.toContain("Banta lagger");
    expect(html).not.toContain("Vanta lagger");
    expect(html).toContain("Activar sonidos");
  });
});
