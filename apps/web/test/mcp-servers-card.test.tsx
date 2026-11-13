import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { InstanceMcpServer } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const OTHER_ORG = "00000000-0000-4000-8000-0000000000aa";
/** From the operator's file (`MCP_STDIO_SERVERS`): read-only here. */
const FILE: InstanceMcpServer = {
  name: "notes",
  address: "stdio://notes",
  label: "Anotações",
  description: null,
  command: "bunx",
  args: ["@acme/notes-mcp", "--root", "/srv/notes"],
  cwd: null,
  orgs: null,
  env: ["NOTES_TOKEN"],
  source: "env",
  state: "ok",
  updatedAt: null,
};
/** Added in Settings, in this workspace and another one. */
const SAVED: InstanceMcpServer = {
  name: "tickets",
  address: "stdio://tickets",
  label: "Chamados",
  description: "Os chamados do suporte",
  command: "bun",
  args: ["run", "/opt/tickets/mcp.ts"],
  cwd: "/opt/tickets",
  orgs: [ORG_ID, OTHER_ORG],
  env: ["TICKETS_KEY"],
  source: "settings",
  state: "ok",
  updatedAt: "2026-11-12T12:00:00.000Z",
};

const go = async (patch: Partial<FakeState> = {}) => {
  const state = seedState(patch);
  await renderApp(`/org/${ORG_ID}/settings/connectors`, { api: createFakeApi(state) });
  await settle(8);
  return state;
};
const card = () => screen().getByRole("region", { name: "Servidores MCP que este servidor roda" });
const click = async (el: Element, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const calls = (state: FakeState, method: string) => state.calls.filter((c) => c.method === method).map((c) => c.args);
const toasts = () => [...document.querySelectorAll(".ac-toast")].map((el) => el.textContent ?? "");

describe("Conectores › the MCP servers this server runs (its owner, off agentes.chat)", () => {
  test("nobody but the server's owner sees it", async () => {
    await go();
    expect(screen().queryByRole("region", { name: "Servidores MCP que este servidor roda" })).toBeNull();
  });

  test("without MCP_STDIO_EDITABLE: the file's servers, and how to add more", async () => {
    await go({ mcpServers: { editable: false, servers: [FILE] } });
    expect(card().textContent).toContain("defina MCP_STDIO_EDITABLE=true nas configurações deste servidor (.env)");
    expect(card().textContent).toContain("Anotações");
    expect(within(card()).queryByRole("button", { name: "Adicionar servidor" })).toBeNull();
  });

  test("a file's server is read-only; a new one sends one argument per line and its variable's value", async () => {
    const state = await go({ mcpServers: { editable: true, servers: [FILE] } });
    const text = card().textContent ?? "";
    expect(text).toContain("stdio://notes");
    expect(text).toContain("bunx @acme/notes-mcp --root /srv/notes");
    expect(text).toContain("Do arquivo do servidor");
    expect(text).toContain("Todos os workspaces");
    expect(within(card()).getByRole("button", { name: "Testar Anotações" })).toBeTruthy();
    expect(within(card()).queryByRole("button", { name: "Editar Anotações" })).toBeNull();
    expect(within(card()).queryByRole("button", { name: "Remover Anotações" })).toBeNull();

    await click(within(card()).getByRole("button", { name: "Adicionar servidor" }));
    const dialog = screen().getByRole("dialog", { name: "Adicionar um servidor MCP" });
    const add = () => within(dialog).getByRole("button", { name: "Adicionar servidor" });
    expect(dialog.textContent).toContain("O comando roda neste servidor com o usuário dele");

    // The name is the address: checked here before anything is sent.
    await type(within(dialog).getByLabelText("Nome"), "meu servidor");
    await type(within(dialog).getByLabelText("Comando"), "bun");
    await click(add());
    expect(dialog.textContent).toContain("Use até 64 letras, números, - ou _, começando com letra ou número.");
    await type(within(dialog).getByLabelText("Nome"), "tickets");
    expect(dialog.textContent).toContain("Os admins conectam em stdio://tickets.");
    await type(within(dialog).getByLabelText("Argumentos"), "run\n\n  /opt/tickets/mcp.ts  \n");

    // A new variable needs its value.
    await click(within(dialog).getByRole("button", { name: "Adicionar variável" }));
    await type(within(dialog).getByLabelText("Nome da variável"), "TICKETS_KEY");
    await click(add());
    expect(dialog.textContent).toContain("Digite um valor para TICKETS_KEY.");
    expect(calls(state, "system.saveMcpServer")).toEqual([]);
    const value = within(dialog).getByLabelText("Valor para TICKETS_KEY") as HTMLInputElement;
    expect(value.type).toBe("password");
    await type(value, "segredo-123");

    await click(add(), 8);
    expect(calls(state, "system.saveMcpServer")).toEqual([
      [
        "tickets",
        {
          label: null,
          description: null,
          command: "bun",
          args: ["run", "/opt/tickets/mcp.ts"],
          cwd: null,
          orgs: [ORG_ID],
          env: [{ name: "TICKETS_KEY", value: "segredo-123" }],
        },
      ],
    ]);
    expect(toasts()).toContain("tickets adicionado. Os admins dos workspaces já podem conectar.");
    expect(screen().queryByRole("dialog", { name: "Adicionar um servidor MCP" })).toBeNull();
    expect(card().textContent).toContain("stdio://tickets");
    expect(card().textContent).toContain("Só este workspace");
    // The value never comes back to the page.
    expect(document.body.innerHTML).not.toContain("segredo-123");
  });

  test("editing keeps a saved variable without sending it, and the other workspaces it is in", async () => {
    const state = await go({ mcpServers: { editable: true, servers: [FILE, SAVED] } });
    expect(card().textContent).toContain("Em 2 workspaces");
    await click(within(card()).getByRole("button", { name: "Editar Chamados" }));
    const dialog = screen().getByRole("dialog", { name: "Editar Chamados" });
    // The name is the address: fixed once made.
    expect(within(dialog).queryByLabelText("Nome")).toBeNull();
    expect((within(dialog).getByLabelText("Nome da variável") as HTMLInputElement).readOnly).toBe(true);
    const value = within(dialog).getByLabelText("Valor para TICKETS_KEY") as HTMLInputElement;
    expect(value.value).toBe("");
    expect(value.placeholder).toBe("Salvo. Deixe vazio para manter.");
    expect((within(dialog).getByLabelText("Argumentos") as HTMLTextAreaElement).value).toBe("run\n/opt/tickets/mcp.ts");
    const scope = within(dialog).getByRole("radiogroup", { name: "Quais workspaces" });
    expect(within(scope).getByRole("radio", { name: "Só os escolhidos" }).getAttribute("aria-checked")).toBe("true");
    expect(dialog.textContent).toContain("Continua nos workspaces onde está agora (2).");

    await type(within(dialog).getByLabelText("Nome exibido"), "Chamados do suporte");
    await click(within(dialog).getByRole("button", { name: "Salvar" }), 8);
    expect(calls(state, "system.saveMcpServer")).toEqual([
      [
        "tickets",
        {
          label: "Chamados do suporte",
          description: "Os chamados do suporte",
          command: "bun",
          args: ["run", "/opt/tickets/mcp.ts"],
          cwd: "/opt/tickets",
          orgs: [ORG_ID, OTHER_ORG],
          env: [{ name: "TICKETS_KEY" }],
        },
      ],
    ]);
    expect(toasts()).toContain("Chamados do suporte salvo.");

    // Every workspace replaces the list.
    await click(within(card()).getByRole("button", { name: "Editar Chamados do suporte" }));
    const again = screen().getByRole("dialog", { name: "Editar Chamados do suporte" });
    await click(within(again).getByRole("radio", { name: "Todos os workspaces" }));
    await click(within(again).getByRole("button", { name: "Salvar" }), 8);
    expect(calls(state, "system.saveMcpServer")[1]?.[1]).toMatchObject({ orgs: null, env: [{ name: "TICKETS_KEY" }] });
  });

  test("Remover asks first", async () => {
    const state = await go({ mcpServers: { editable: true, servers: [SAVED] } });
    await click(within(card()).getByRole("button", { name: "Remover Chamados" }));
    const ask = screen().getByRole("dialog", { name: "Remover Chamados?" });
    expect(calls(state, "system.removeMcpServer")).toEqual([]);
    await click(within(ask).getByRole("button", { name: "Remover" }), 8);
    expect(calls(state, "system.removeMcpServer")).toEqual([["tickets"]]);
    expect(toasts()).toContain("Chamados removido deste servidor.");
    expect(card().textContent).not.toContain("stdio://tickets");
  });

  test("Testar shows its tools, or why it didn't start with what it said", async () => {
    const tools = Array.from({ length: 12 }, (_, n) => ({ name: `tool_${n + 1}`, description: null }));
    await go({
      mcpServers: { editable: true, servers: [FILE, SAVED] },
      mcpServerTests: {
        notes: { ok: false, reason: "not_found", detail: "spawn npx ENOENT" },
        tickets: { ok: true, tools },
      },
    });
    await click(within(card()).getByRole("button", { name: "Testar Anotações" }));
    expect(card().textContent).toContain("Este servidor não encontra o comando.");
    expect(card().textContent).toContain("a imagem Docker tem bun e bunx, mas não npx nem uvx.");
    expect(card().querySelector("pre")?.textContent).toBe("spawn npx ENOENT");

    await click(within(card()).getByRole("button", { name: "Testar Chamados" }));
    expect(card().textContent).toContain("Iniciou e oferece 12 ferramentas.");
    const listed = [...card().querySelectorAll(".mcp-servers__tools code")].map((el) => el.textContent);
    expect(listed).toEqual(tools.slice(0, 10).map((t) => t.name));
    expect(card().textContent).toContain("e mais 2");
  });
});
