import type { InstanceMcpServer, InstanceMcpServerDraft, InstanceMcpServerTest } from "@agenteschat/client";
import { useMcpServers, useRemoveMcpServer, useSaveMcpServer, useTestMcpServer } from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import {
  Button,
  Card,
  CardHeader,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Input,
  List,
  Locked,
  Segmented,
  SettingNote,
  Textarea,
  useUnsavedInDialog,
} from "@agenteschat/ui";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/*
 * Settings › Connectors, for the server's pinned owner only (the API answers null to everyone else and on
 * agentes.chat): the MCP servers this server runs as local processes, from its file or added here.
 */

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Tool names shown after a test; the rest is a count. */
const TOOLS_SHOWN = 10;

/** `command arg …`, an argument with spaces (or none at all) in quotes. */
const commandLine = (s: InstanceMcpServer) =>
  [s.command, ...s.args.map((a) => (a === "" || /\s/.test(a) ? JSON.stringify(a) : a))].join(" ");

type Tried = { result: InstanceMcpServerTest } | { error: string };

export function McpServersCard() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const view = useMcpServers().data;
  const test = useTestMcpServer();
  const remove = useRemoveMcpServer();
  const toast = useToast();
  const [tried, setTried] = useState<Record<string, Tried>>({});
  // Each dialog's server stays while it closes: its content doesn't change under the exit animation.
  const [form, setForm] = useState<{ server: InstanceMcpServer | null; n: number } | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [removing, setRemoving] = useState<InstanceMcpServer | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  if (!view) return null;

  const openForm = (server: InstanceMcpServer | null) => {
    setForm((f) => ({ server, n: (f?.n ?? 0) + 1 }));
    setFormOpen(true);
  };

  return (
    <Card aria-labelledby="sec-mcp-servers">
      <CardHeader
        id="sec-mcp-servers"
        icon="computer"
        title={t("mcpServers.title")}
        subtitle={t("mcpServers.lead")}
        action={
          view.editable && (
            <Button size="sm" icon="plus" onClick={() => openForm(null)}>
              {t("mcpServers.add")}
            </Button>
          )
        }
      />
      {!view.editable && <SettingNote icon="info">{t("mcpServers.notEditable")}</SettingNote>}
      {view.servers.length === 0 ? (
        view.editable && <p className="small muted">{t("mcpServers.none")}</p>
      ) : (
        <List className="mcp-servers" aria-label={t("mcpServers.title")}>
          {view.servers.map((s) => {
            const settings = s.source === "settings";
            const outcome = tried[s.name];
            return (
              <div key={s.name} className="ac-list__row">
                <span className="list-col mcp-servers__info">
                  <span className="list-title">
                    <span>{s.label}</span>
                    {!settings && <Chip>{t("mcpServers.fromFile")}</Chip>}
                  </span>
                  <code className="small muted mcp-servers__code">{s.address}</code>
                  <code className="small muted mcp-servers__code">{commandLine(s)}</code>
                  <span className="small muted">
                    {s.orgs === null
                      ? t("mcpServers.orgs.all")
                      : s.orgs.length === 1 && s.orgs[0] === org.id
                        ? t("mcpServers.orgs.here")
                        : t("mcpServers.orgs.count", { count: s.orgs.length })}
                  </span>
                  {s.state === "invalid" && <SettingNote icon="alert">{t("mcpServers.invalid")}</SettingNote>}
                  <div className="mcp-servers__test" aria-live="polite">
                    {outcome && <TestOutcome tried={outcome} />}
                  </div>
                </span>
                <span className="ac-acts">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("mcpServers.test.name", { name: s.label })}
                    loading={test.isPending && test.variables === s.name}
                    disabled={test.isPending}
                    onClick={() =>
                      test.mutate(s.name, {
                        onSuccess: (result) => setTried((all) => ({ ...all, [s.name]: { result } })),
                        onError: (e) =>
                          setTried((all) => ({ ...all, [s.name]: { error: errorText(t, e, i18n.language) } })),
                      })
                    }
                  >
                    {t("mcpServers.test.button")}
                  </Button>
                  {settings && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t("mcpServers.editName", { name: s.label })}
                      onClick={() => openForm(s)}
                    >
                      {t("mcpServers.edit")}
                    </Button>
                  )}
                  {settings && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ac-btn--danger"
                      aria-label={t("mcpServers.removeName", { name: s.label })}
                      onClick={() => {
                        setRemoveError(null);
                        setRemoving(s);
                        setRemoveOpen(true);
                      }}
                    >
                      {t("mcpServers.remove")}
                    </Button>
                  )}
                </span>
              </div>
            );
          })}
        </List>
      )}
      <Dialog
        open={formOpen}
        onOpenChange={setFormOpen}
        title={
          form?.server ? t("mcpServers.form.editTitle", { name: form.server.label }) : t("mcpServers.form.addTitle")
        }
        description={form?.server?.address}
        closeLabel={t("common.close")}
      >
        {form && (
          <McpServerForm
            key={form.n}
            server={form.server}
            taken={view.servers.map((s) => s.name.toLowerCase())}
            onClose={() => setFormOpen(false)}
          />
        )}
      </Dialog>
      <Dialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t("mcpServers.removeTitle", { name: removing?.label ?? "" })}
        description={t("mcpServers.removeText")}
        closeLabel={t("common.close")}
        width={440}
      >
        {removeError && (
          <DialogBody>
            <p className="ac-field__error" role="alert">
              {removeError}
            </p>
          </DialogBody>
        )}
        <DialogFooter>
          <Button onClick={() => setRemoveOpen(false)}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            loading={remove.isPending}
            onClick={() => {
              if (!removing) return;
              const { name, label } = removing;
              remove.mutate(name, {
                onSuccess: () => {
                  setRemoveOpen(false);
                  setTried(({ [name]: _, ...rest }) => rest);
                  toast.show(t("mcpServers.removed", { name: label }));
                },
                onError: (e) => setRemoveError(errorText(t, e, i18n.language)),
              });
            }}
          >
            {t("mcpServers.remove")}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}

/** A test's outcome under its row: the tools it offers, or why it didn't start and what it said. */
function TestOutcome({ tried }: { tried: Tried }) {
  const { t } = useTranslation();
  if ("error" in tried) return <SettingNote icon="alert">{tried.error}</SettingNote>;
  const { result } = tried;
  if (!result.ok) {
    return (
      <>
        <SettingNote icon="alert">{t(`mcpServers.test.${result.reason}`)}</SettingNote>
        {result.detail && <pre className="mcp-servers__detail">{result.detail}</pre>}
      </>
    );
  }
  if (result.tools.length === 0) return <SettingNote icon="check">{t("mcpServers.test.noTools")}</SettingNote>;
  const rest = result.tools.length - TOOLS_SHOWN;
  return (
    <>
      <SettingNote icon="check">{t("mcpServers.test.started", { count: result.tools.length })}</SettingNote>
      <ul className="mcp-servers__tools">
        {result.tools.slice(0, TOOLS_SHOWN).map((tool) => (
          <li key={tool.name} title={tool.description ?? undefined}>
            <code>{tool.name}</code>
          </li>
        ))}
        {rest > 0 && <li className="muted">{t("mcpServers.test.more", { count: rest })}</li>}
      </ul>
    </>
  );
}

interface VarRow {
  key: number;
  name: string;
  value: string;
  /** Saved on the server: an empty value keeps the one there. */
  saved: boolean;
}

type FormErrors = Partial<Record<"name" | "command" | "vars" | "form", string>>;

/** Adding or editing one server: a variable already saved is never shown, and sent without a value to keep it. */
function McpServerForm({
  server,
  taken,
  onClose,
}: {
  server: InstanceMcpServer | null;
  /** Names already on this server (lower case): a new one can't reuse them. */
  taken: string[];
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const save = useSaveMcpServer();
  const id = useId();
  const [name, setName] = useState("");
  const [label, setLabel] = useState(server?.label ?? "");
  const [description, setDescription] = useState(server?.description ?? "");
  const [command, setCommand] = useState(server?.command ?? "");
  const [args, setArgs] = useState(server?.args.join("\n") ?? "");
  const [cwd, setCwd] = useState(server?.cwd ?? "");
  const [vars, setVars] = useState<VarRow[]>(
    () => server?.env.map((n, key) => ({ key, name: n, value: "", saved: true })) ?? [],
  );
  const [nextKey, setNextKey] = useState(server?.env.length ?? 0);
  // A new server starts in this workspace only; one in other workspaces keeps them unless it goes to every one.
  const [scope, setScope] = useState<"all" | "chosen">(server && server.orgs === null ? "all" : "chosen");
  const [errors, setErrors] = useState<FormErrors>({});
  const others = server?.orgs?.some((o) => o !== org.id) ?? false;
  const chosen = server?.orgs ?? [org.id];
  const varsHelp = `${id}-vars-help`;

  const touch = (key: keyof FormErrors) =>
    setErrors((e) => (e[key] || e.form ? { ...e, [key]: undefined, form: undefined } : e));
  const setVar = (key: number, patch: Partial<VarRow>) => {
    setVars((all) => all.map((v) => (v.key === key ? { ...v, ...patch } : v)));
    touch("vars");
  };

  const check = (): FormErrors => {
    const found: FormErrors = {};
    const wanted = name.trim();
    if (!server) {
      if (!NAME.test(wanted)) found.name = t("mcpServers.form.nameInvalid");
      else if (taken.includes(wanted.toLowerCase())) found.name = t("mcpServers.form.nameTaken");
    }
    if (!command.trim()) found.command = t("mcpServers.form.commandRequired");
    const seen = new Set<string>();
    for (const v of vars) {
      const n = v.name.trim();
      if (!v.saved && !n && !v.value) continue;
      if (!VAR_NAME.test(n)) found.vars = t("mcpServers.form.varNameInvalid");
      else if (seen.has(n)) found.vars = t("mcpServers.form.varNameTwice", { name: n });
      else if (!v.saved && !v.value) found.vars = t("mcpServers.form.varValueRequired", { name: n });
      if (found.vars) break;
      seen.add(n);
    }
    return found;
  };

  const submit = () => {
    const found = check();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const draft: InstanceMcpServerDraft = {
      label: label.trim() || null,
      description: description.trim() || null,
      command: command.trim(),
      args: args
        .split("\n")
        .map((a) => a.trim())
        .filter((a) => a !== ""),
      cwd: cwd.trim() || null,
      orgs: scope === "all" ? null : chosen,
      env: vars
        .filter((v) => v.saved || v.name.trim() || v.value)
        .map((v) => (v.saved && !v.value ? { name: v.name } : { name: v.name.trim(), value: v.value })),
    };
    save.mutate(
      { name: server?.name ?? name.trim(), draft },
      {
        onSuccess: (saved) => {
          toast.show(t(server ? "mcpServers.saved" : "mcpServers.added", { name: saved.label }));
          onClose();
        },
        onError: (e) => {
          const code = errorCode(e);
          if (code === "mcp_server_env") setErrors({ name: t("mcpServers.form.nameInFile") });
          else if (code === "mcp_server_not_editable") setErrors({ form: t("mcpServers.form.notEditable") });
          else setErrors({ form: errorText(t, e, i18n.language) });
        },
      },
    );
  };

  const address = `stdio://${name.trim() || t("mcpServers.form.namePlaceholder")}`;
  // A filled form stays open on a press outside or Esc.
  useUnsavedInDialog(
    name !== "" ||
      label !== (server?.label ?? "") ||
      description !== (server?.description ?? "") ||
      command !== (server?.command ?? "") ||
      args !== (server?.args.join("\n") ?? "") ||
      cwd !== (server?.cwd ?? "") ||
      vars.some((v) => !v.saved || v.value !== "") ||
      vars.length !== (server?.env.length ?? 0),
  );

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Locked when={save.isPending}>
        <DialogBody>
          {!server && (
            <Field
              label={t("mcpServers.form.name")}
              example={t("mcpServers.form.nameExample", { address })}
              error={errors.name}
            >
              <Input
                value={name}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
                placeholder={t("mcpServers.form.namePlaceholder")}
                onChange={(e) => {
                  setName(e.target.value);
                  touch("name");
                }}
              />
            </Field>
          )}
          {server && errors.name && (
            <p className="ac-field__error" role="alert">
              {errors.name}
            </p>
          )}
          <Field label={t("mcpServers.form.label")} example={t("mcpServers.form.labelExample")}>
            <Input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field label={t("mcpServers.form.description")}>
            <Input value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label={t("mcpServers.form.command")} error={errors.command}>
            <Input
              className="mcp-form__code"
              value={command}
              autoFocus={Boolean(server)}
              autoComplete="off"
              spellCheck={false}
              maxLength={1000}
              placeholder="bunx"
              onChange={(e) => {
                setCommand(e.target.value);
                touch("command");
              }}
            />
          </Field>
          <Field label={t("mcpServers.form.args")} example={t("mcpServers.form.argsExample")}>
            <Textarea
              className="mcp-form__code"
              value={args}
              rows={3}
              autoGrow
              spellCheck={false}
              onChange={(e) => setArgs(e.target.value)}
            />
          </Field>
          <Field label={t("mcpServers.form.cwd")}>
            <Input
              className="mcp-form__code"
              value={cwd}
              autoComplete="off"
              spellCheck={false}
              maxLength={1000}
              onChange={(e) => setCwd(e.target.value)}
            />
          </Field>
          {/* biome-ignore lint/a11y/useSemanticElements: rows of fields inside the form's own fieldset, not another one */}
          <div className="mcp-form__vars" role="group" aria-labelledby={`${id}-vars`}>
            <span className="ac-field__label" id={`${id}-vars`}>
              {t("mcpServers.form.vars")}
            </span>
            {vars.length === 0 && <span className="small muted">{t("mcpServers.form.varsNone")}</span>}
            {vars.map((v) => {
              const shown = v.name.trim() || t("mcpServers.form.newVar");
              return (
                <div key={v.key} className="mcp-form__var">
                  <Input
                    className="mcp-form__code"
                    value={v.name}
                    readOnly={v.saved}
                    aria-label={t("mcpServers.form.varName")}
                    aria-describedby={errors.vars ? varsHelp : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={200}
                    placeholder="API_KEY"
                    onChange={(e) => setVar(v.key, { name: e.target.value })}
                  />
                  <Input
                    type="password"
                    value={v.value}
                    aria-label={t("mcpServers.form.varValue", { name: shown })}
                    aria-describedby={errors.vars ? varsHelp : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={v.saved ? t("mcpServers.form.savedValue") : t("mcpServers.form.value")}
                    onChange={(e) => setVar(v.key, { value: e.target.value })}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon="trash"
                    aria-label={t("mcpServers.form.removeVar", { name: shown })}
                    onClick={() => {
                      setVars((all) => all.filter((x) => x.key !== v.key));
                      touch("vars");
                    }}
                  />
                </div>
              );
            })}
            {errors.vars && (
              <span id={varsHelp} className="ac-field__error">
                {errors.vars}
              </span>
            )}
            <span className="ac-acts">
              <Button
                size="sm"
                variant="ghost"
                icon="plus"
                onClick={() => {
                  setVars((all) => [...all, { key: nextKey, name: "", value: "", saved: false }]);
                  setNextKey((k) => k + 1);
                }}
              >
                {t("mcpServers.form.addVar")}
              </Button>
            </span>
          </div>
          <Field
            label={t("mcpServers.form.orgs")}
            group
            example={scope === "chosen" && others ? t("mcpServers.form.orgsKept", { count: chosen.length }) : undefined}
          >
            <Segmented
              value={scope}
              onValueChange={setScope}
              label={t("mcpServers.form.orgs")}
              options={[
                { value: "all", label: t("mcpServers.orgs.all") },
                { value: "chosen", label: others ? t("mcpServers.form.orgsChosen") : t("mcpServers.orgs.here") },
              ]}
            />
          </Field>
          <SettingNote icon="alert">{t("mcpServers.form.warning")}</SettingNote>
          {errors.form && (
            <p className="ac-field__error" role="alert">
              {errors.form}
            </p>
          )}
        </DialogBody>
      </Locked>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={save.isPending} loading={save.isPending}>
          {server ? t("common.save") : t("mcpServers.form.submitAdd")}
        </Button>
      </DialogFooter>
    </form>
  );
}
