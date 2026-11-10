import type {
  ContentAccountsState,
  ContentMediaHostInput,
  ContentNetworkView,
  ContentPlatform,
} from "@openbot/contracts/ipc-content";
import {
  Alert,
  AlertActions,
  AlertContent,
  AlertDescription,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  IconButton,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
  Skeleton,
  Text,
  X,
} from "@openbot/ui";
import { ContentNetworkMark } from "@openbot/ui/features/content/ContentParts";
import { CONTENT_NETWORK_NAMES, contentGateKey } from "@openbot/ui/features/content/content-status";
import { useText } from "@openbot/ui/text";
import { createEffect, createStore, For, flush, Match, onSettled, Show, Switch } from "solid-js";
import type { ContentState } from "./content-context";

/** Instagram is connected, and no image host is set up: it cannot post (G13). */
const needsHost = (network: ContentNetworkView, hostConfigured: boolean) =>
  network.platform === "instagram" && network.account?.status === "connected" && !hostConfigured;

/** The badge of a network, as `ProviderAccountList` maps account states. */
function accountBadge(network: ContentNetworkView, hostConfigured: boolean) {
  if (!network.available) return { variant: "outline", key: "content.accounts.status.unavailable" } as const;
  const status = network.account?.status;
  if (needsHost(network, hostConfigured))
    return { variant: "warning-light", key: "content.network.needsHost" } as const;
  if (status === "connected") return { variant: "success-light", key: "content.accounts.status.connected" } as const;
  if (status === "expired") return { variant: "warning-light", key: "content.accounts.status.signedOut" } as const;
  return null;
}

export interface ContentAccountsDialogProps {
  content: ContentState;
}

/** The accounts that OpenBot posts with: one row per network, with Connect, Reconnect and Disconnect. */
export function ContentAccountsDialog(props: ContentAccountsDialogProps) {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<{
    /** The network whose app fields show. */
    setup: ContentPlatform | null;
    clientId: string;
    clientSecret: string;
    errors: Partial<Record<ContentPlatform, string>>;
    disconnect: ContentNetworkView | null;
    /** The sign-in that this window started, before the first refresh shows it. */
    starting: ContentPlatform | null;
    /** The image host fields of the Instagram row. The two keys are never filled from main. */
    host: Required<ContentMediaHostInput>;
  }>({
    setup: null,
    clientId: "",
    clientSecret: "",
    errors: {},
    disconnect: null,
    starting: null,
    host: { endpoint: "", bucket: "", publicBaseUrl: "", accessKeyId: "", secretAccessKey: "" },
  });
  const accounts = () => props.content.state.accounts;
  const connecting = () => state.starting ?? accounts()?.connecting ?? null;
  const open = () => props.content.state.accountsDialog !== null;
  // A controlled dialog has no Kobalte trigger, so it keeps the element that opened it, as `ConfirmDialog` does.
  let restoreTarget: HTMLElement | undefined;
  let restoreFrame: number | undefined;
  onSettled(() => () => {
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame);
  });
  // A typed client secret that was not sent does not stay in memory after the dialog closes.
  createEffect(open, (isOpen) => {
    if (isOpen) return;
    setState((draft) => {
      draft.setup = null;
      draft.clientId = "";
      draft.clientSecret = "";
      draft.host.accessKeyId = "";
      draft.host.secretAccessKey = "";
    });
  });
  const hostView = () => accounts()?.mediaHost ?? null;
  const hostConfigured = () => hostView()?.configured === true;
  let dialog: HTMLElement | undefined;
  /** The host fields that the Instagram row sends; an empty key field keeps the saved key. */
  const hostInput = (): ContentMediaHostInput => ({
    endpoint: state.host.endpoint.trim(),
    bucket: state.host.bucket.trim(),
    publicBaseUrl: state.host.publicBaseUrl.trim(),
    ...(state.host.accessKeyId.trim() ? { accessKeyId: state.host.accessKeyId.trim() } : {}),
    ...(state.host.secretAccessKey ? { secretAccessKey: state.host.secretAccessKey } : {}),
  });
  const hostIncomplete = () =>
    !state.host.endpoint.trim() ||
    !state.host.bucket.trim() ||
    !state.host.publicBaseUrl.trim() ||
    (!hostView()?.hasKeys && (!state.host.accessKeyId.trim() || !state.host.secretAccessKey));
  /** Opens the setup fields of a network, with the saved values. */
  const openSetup = (network: ContentNetworkView) => {
    setState((draft) => {
      draft.setup = network.platform;
      draft.clientId = network.app.clientId ?? "";
      draft.clientSecret = "";
      const host = hostView();
      draft.host = {
        endpoint: host?.endpoint ?? "",
        bucket: host?.bucket ?? "",
        publicBaseUrl: host?.publicBaseUrl ?? "",
        accessKeyId: "",
        secretAccessKey: "",
      };
    });
    // G13: the host fields of Instagram take focus on their first empty field.
    if (network.platform !== "instagram") return;
    flush();
    const empty = [...(dialog?.querySelectorAll<HTMLInputElement>(".content-account-host input") ?? [])].find(
      (input) => !input.value,
    );
    empty?.focus();
  };

  // `openAccounts("instagram")` from the composer or the queue opens the image host step at once, so it
  // takes one click. Only while Instagram is connected and has no host: a Connect asks for it anyway.
  // The compute gives a string, so a reload of the accounts does not open the step again over typed values.
  createEffect(
    () => {
      const platform = props.content.state.accountsDialog?.platform;
      const network = accounts()?.networks.find((candidate) => candidate.platform === platform);
      return network && needsHost(network, hostConfigured()) ? network.platform : null;
    },
    (platform) => {
      if (!platform) return;
      // The store is read in the frame, not in this callback (Solid 2: no store reads in an effect callback).
      requestAnimationFrame(() => {
        const network = accounts()?.networks.find((candidate) => candidate.platform === platform);
        if (network) openSetup(network);
      });
    },
  );

  const setError = (platform: ContentPlatform, error: string | undefined) =>
    setState((draft) => {
      if (error === undefined) delete draft.errors[platform];
      else draft.errors[platform] = error;
    });

  async function call(platform: ContentPlatform, work: () => Promise<ContentAccountsState>) {
    setError(platform, undefined);
    try {
      props.content.setAccounts(await work());
    } catch (error) {
      setError(
        platform,
        errorMessage(error, t("content.error.connectFailed", { network: CONTENT_NETWORK_NAMES[platform] })),
      );
      void props.content.reloadAccounts();
    }
  }

  function connect(network: ContentNetworkView) {
    // Each network needs the client ID of the user's own app first, some also its secret. Instagram
    // needs the image host too.
    const needsApp =
      !network.app.configured ||
      (network.app.needsSecret && !network.app.hasSecret) ||
      (network.platform === "instagram" && !hostView()?.configured);
    if (needsApp && state.setup !== network.platform) {
      openSetup(network);
      return;
    }
    const clientId = state.setup === network.platform ? state.clientId.trim() : "";
    const clientSecret = state.setup === network.platform ? state.clientSecret : "";
    const mediaHost = state.setup === "instagram" && network.platform === "instagram" ? hostInput() : null;
    // The wait shows at once, so a second click cannot start, or cancel, a second sign-in.
    setState((draft) => {
      draft.setup = null;
      draft.clientSecret = "";
      draft.host.accessKeyId = "";
      draft.host.secretAccessKey = "";
      draft.starting = network.platform;
    });
    // `beginConnect` ends when the sign-in ends; `connecting` shows the wait meanwhile.
    void call(network.platform, () =>
      props.content.port().content.beginConnect({
        platform: network.platform,
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
        ...(mediaHost ? { mediaHost } : {}),
      }),
    ).finally(() =>
      setState((draft) => {
        if (draft.starting === network.platform) draft.starting = null;
      }),
    );
    void props.content.reloadAccounts();
  }

  /** New image host values for a connected Instagram account: main checks and saves them, with no sign-in. */
  function saveHost(network: ContentNetworkView) {
    const mediaHost = hostInput();
    setState((draft) => {
      draft.setup = null;
      draft.host.accessKeyId = "";
      draft.host.secretAccessKey = "";
    });
    // The Save button is gone: focus goes to the action of the row.
    flush();
    dialog?.querySelector<HTMLElement>(`[data-platform="${network.platform}"] .ui-item-actions button`)?.focus();
    void call(network.platform, () =>
      props.content.port().content.beginConnect({ platform: network.platform, mediaHost }),
    );
  }

  const cancel = (platform: ContentPlatform) =>
    void call(platform, () => props.content.port().content.disconnectAccount({ platform, cancel: true }));

  async function disconnect() {
    const network = state.disconnect;
    const account = network?.account;
    if (!network || !account) return;
    await call(network.platform, () => props.content.port().content.disconnectAccount({ accountId: account.id }));
    setState((draft) => {
      draft.disconnect = null;
    });
  }

  return (
    <>
      <Dialog.Root open={open()} onOpenChange={(next) => !next && props.content.closeAccounts()}>
        <Dialog.Portal>
          <Dialog.Overlay>
            <Dialog.Content
              as="section"
              ref={dialog}
              class="content-accounts"
              onOpenAutoFocus={() => {
                const opener = document.activeElement;
                restoreTarget = opener instanceof HTMLElement && opener !== document.body ? opener : undefined;
              }}
              onCloseAutoFocus={(event) => {
                const target = restoreTarget;
                if (!target?.isConnected) return;
                event.preventDefault();
                target.focus({ preventScroll: true });
                restoreFrame = requestAnimationFrame(() => {
                  if (!open() && target.isConnected) target.focus({ preventScroll: true });
                });
              }}
            >
              <header class="content-accounts-head">
                <div>
                  <Dialog.Title as="h2">{t("content.accounts.title")}</Dialog.Title>
                  <Dialog.Description>{t("content.accounts.description")}</Dialog.Description>
                </div>
                <Dialog.CloseButton as={IconButton} variant="ghost" label={t("common.close")}>
                  <X />
                </Dialog.CloseButton>
              </header>
              <Show
                when={accounts()}
                fallback={
                  props.content.state.accountsError ? (
                    <Alert tone="danger" role="alert">
                      <AlertContent>
                        <AlertDescription>{t("content.accounts.loadFailed")}</AlertDescription>
                      </AlertContent>
                      <AlertActions>
                        <Button variant="outline" size="sm" onClick={() => void props.content.reloadAccounts()}>
                          {t("common.retry")}
                        </Button>
                      </AlertActions>
                    </Alert>
                  ) : (
                    <div aria-busy="true">
                      <p class="sr-only" role="status">
                        {t("content.accounts.loading")}
                      </p>
                      <For each={[0, 1, 2]}>{() => <Skeleton class="content-skeleton-row" />}</For>
                    </div>
                  )
                }
              >
                {(current) => (
                  <ItemGroup role="list">
                    <For each={current().networks} keyed={(network) => network.platform}>
                      {(network) => {
                        const name = () => CONTENT_NETWORK_NAMES[network().platform];
                        const badge = () => accountBadge(network(), hostConfigured());
                        const account = () =>
                          network().account?.status === "revoked" ? null : (network().account ?? null);
                        return (
                          <Item
                            role="listitem"
                            class="content-account"
                            data-platform={network().platform}
                            data-focus={
                              props.content.state.accountsDialog?.platform === network().platform ? "" : undefined
                            }
                          >
                            <ItemMedia>
                              <ContentNetworkMark platform={network().platform} class="content-network-mark" />
                            </ItemMedia>
                            <ItemContent>
                              <ItemTitle>{name()}</ItemTitle>
                              <ItemDescription>
                                {!network().available
                                  ? t(contentGateKey(network().platform))
                                  : (account()?.displayName ?? account()?.handle ?? t("content.accounts.notConnected"))}
                              </ItemDescription>
                              <Show when={state.errors[network().platform]}>
                                {(error) => (
                                  <Text tone="danger" variant="caption" role="alert">
                                    {error()}
                                  </Text>
                                )}
                              </Show>
                              <Show when={state.setup === network().platform && account()?.status !== "connected"}>
                                <div class="content-account-app">
                                  <Field
                                    label={t("content.accounts.clientId", { network: name() })}
                                    description={t("content.accounts.clientIdHint", { network: name() })}
                                    required
                                  >
                                    <Input
                                      value={state.clientId}
                                      autocomplete="off"
                                      spellcheck={false}
                                      onValueChange={(value) =>
                                        setState((draft) => {
                                          draft.clientId = value;
                                        })
                                      }
                                    />
                                  </Field>
                                  <Show when={network().app.needsSecret}>
                                    <Field
                                      label={t("content.accounts.clientSecret", { network: name() })}
                                      description={t("content.accounts.clientSecretHint")}
                                      required={!network().app.hasSecret}
                                    >
                                      <Input
                                        type="password"
                                        value={state.clientSecret}
                                        autocomplete="off"
                                        onValueChange={(value) =>
                                          setState((draft) => {
                                            draft.clientSecret = value;
                                          })
                                        }
                                      />
                                    </Field>
                                  </Show>
                                </div>
                              </Show>
                              <Show when={network().platform === "instagram" && network().available}>
                                <Show when={hostView()?.configured && state.setup !== "instagram"}>
                                  <Text variant="caption">{t("content.accounts.mediaHost.configured")}</Text>
                                </Show>
                                <Show when={state.setup === "instagram"}>
                                  <fieldset class="content-account-app content-account-host">
                                    <legend>{t("content.accounts.mediaHost.title")}</legend>
                                    <Text variant="caption">{t("content.accounts.mediaHost.description")}</Text>
                                    <Field label={t("content.accounts.mediaHost.endpoint")} required>
                                      <Input
                                        type="url"
                                        value={state.host.endpoint}
                                        autocomplete="off"
                                        spellcheck={false}
                                        onValueChange={(value) =>
                                          setState((draft) => {
                                            draft.host.endpoint = value;
                                          })
                                        }
                                      />
                                    </Field>
                                    <Field label={t("content.accounts.mediaHost.bucket")} required>
                                      <Input
                                        value={state.host.bucket}
                                        autocomplete="off"
                                        spellcheck={false}
                                        onValueChange={(value) =>
                                          setState((draft) => {
                                            draft.host.bucket = value;
                                          })
                                        }
                                      />
                                    </Field>
                                    <Field
                                      label={t("content.accounts.mediaHost.publicBaseUrl")}
                                      description={t("content.accounts.mediaHost.publicBaseUrlHint")}
                                      required
                                    >
                                      <Input
                                        type="url"
                                        value={state.host.publicBaseUrl}
                                        autocomplete="off"
                                        spellcheck={false}
                                        onValueChange={(value) =>
                                          setState((draft) => {
                                            draft.host.publicBaseUrl = value;
                                          })
                                        }
                                      />
                                    </Field>
                                    <Field
                                      label={t("content.accounts.mediaHost.accessKeyId")}
                                      description={t("content.accounts.mediaHost.keysHint")}
                                      required={!hostView()?.hasKeys}
                                    >
                                      <Input
                                        type="password"
                                        value={state.host.accessKeyId}
                                        autocomplete="off"
                                        onValueChange={(value) =>
                                          setState((draft) => {
                                            draft.host.accessKeyId = value;
                                          })
                                        }
                                      />
                                    </Field>
                                    <Field
                                      label={t("content.accounts.mediaHost.secretAccessKey")}
                                      required={!hostView()?.hasKeys}
                                    >
                                      <Input
                                        type="password"
                                        value={state.host.secretAccessKey}
                                        autocomplete="off"
                                        onValueChange={(value) =>
                                          setState((draft) => {
                                            draft.host.secretAccessKey = value;
                                          })
                                        }
                                      />
                                    </Field>
                                  </fieldset>
                                </Show>
                              </Show>
                            </ItemContent>
                            <Show when={badge()}>
                              {(current) => <Badge variant={current().variant}>{t(current().key)}</Badge>}
                            </Show>
                            <ItemActions>
                              <Show when={network().available}>
                                <Switch>
                                  <Match when={connecting() === network().platform}>
                                    <Button
                                      variant="outline"
                                      size="xs"
                                      loading
                                      loadingLabel={t("content.accounts.connecting", { network: name() })}
                                    >
                                      {t("content.accounts.connecting", { network: name() })}
                                    </Button>
                                    <Button variant="ghost" size="xs" onClick={() => cancel(network().platform)}>
                                      {t("common.cancel")}
                                    </Button>
                                  </Match>
                                  <Match when={account()?.status === "connected" && state.setup === "instagram"}>
                                    <Button
                                      variant="outline"
                                      size="xs"
                                      disabled={hostIncomplete()}
                                      onClick={() => saveHost(network())}
                                    >
                                      {t("common.save")}
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="xs"
                                      onClick={() =>
                                        setState((draft) => {
                                          draft.setup = null;
                                        })
                                      }
                                    >
                                      {t("common.cancel")}
                                    </Button>
                                  </Match>
                                  <Match when={account()?.status === "connected"}>
                                    <Show when={network().platform === "instagram"}>
                                      {/* One button, so focus stays on it when a saved host changes its label. */}
                                      <Button
                                        variant={needsHost(network(), hostConfigured()) ? "outline" : "ghost"}
                                        size="xs"
                                        onClick={() => openSetup(network())}
                                      >
                                        {needsHost(network(), hostConfigured())
                                          ? t("content.action.setUpHost")
                                          : t("content.accounts.mediaHost.title")}
                                      </Button>
                                    </Show>
                                    <Button
                                      variant="ghost"
                                      size="xs"
                                      onClick={() =>
                                        setState((draft) => {
                                          draft.disconnect = network();
                                        })
                                      }
                                    >
                                      {t("content.accounts.disconnect")}
                                    </Button>
                                  </Match>
                                  <Match when={true}>
                                    <Button
                                      variant="outline"
                                      size="xs"
                                      disabled={
                                        connecting() !== null ||
                                        (state.setup === network().platform &&
                                          (!state.clientId.trim() ||
                                            (network().app.needsSecret &&
                                              !network().app.hasSecret &&
                                              !state.clientSecret) ||
                                            (network().platform === "instagram" && hostIncomplete())))
                                      }
                                      onClick={() => connect(network())}
                                    >
                                      {account()?.status === "expired"
                                        ? t("content.accounts.reconnect")
                                        : t("content.accounts.connect")}
                                    </Button>
                                  </Match>
                                </Switch>
                              </Show>
                            </ItemActions>
                          </Item>
                        );
                      }}
                    </For>
                  </ItemGroup>
                )}
              </Show>
            </Dialog.Content>
          </Dialog.Overlay>
        </Dialog.Portal>
      </Dialog.Root>
      <ConfirmDialog
        open={state.disconnect !== null}
        title={t("content.confirm.disconnect.title", {
          network: state.disconnect ? CONTENT_NETWORK_NAMES[state.disconnect.platform] : "",
        })}
        description={t("content.confirm.disconnect.body", { handle: state.disconnect?.account?.handle ?? "" })}
        confirmLabel={t("content.confirm.disconnect.action")}
        onCancel={() =>
          setState((draft) => {
            draft.disconnect = null;
          })
        }
        onConfirm={disconnect}
      />
    </>
  );
}
