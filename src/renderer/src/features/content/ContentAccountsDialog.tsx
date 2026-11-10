import {
  CONTENT_REDIRECT_URI,
  type ContentAccountsState,
  type ContentMediaHostInput,
  type ContentNetworkView,
  type ContentPlatform,
  contentShortHost,
} from "@openbot/contracts/ipc-content";
import { sourceText } from "@openbot/i18n/source";
import {
  Alert,
  AlertActions,
  AlertContent,
  AlertDescription,
  Badge,
  Button,
  ConfirmDialog,
  CopyButton,
  Dialog,
  Field,
  IconButton,
  Image,
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
import { createEffect, createStore, createUniqueId, For, flush, Match, onSettled, Show, Switch } from "solid-js";
import type { ContentState } from "./content-context";

/** Instagram has no image host: it cannot post, and its Connect waits for the host (G13). */
const needsHost = (network: ContentNetworkView, hostConfigured: boolean) =>
  network.platform === "instagram" && network.available && !hostConfigured;

/** The read-only redirect address with a copy action: the same for every network. */
function RedirectUriField(props: { network: string }) {
  const { t } = useText();
  return (
    <Field
      label={t("content.accounts.redirectUri")}
      description={t("content.accounts.redirectUriHint", { network: props.network })}
    >
      <span class="content-redirect">
        <Input value={CONTENT_REDIRECT_URI} readonly spellcheck={false} />
        <CopyButton value={CONTENT_REDIRECT_URI} variant="outline" size="sm" />
      </span>
    </Field>
  );
}

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
    /** The image host fields of the host row. The two keys are never filled from main. */
    host: Required<ContentMediaHostInput>;
    /** The host row shows its fields. */
    hostOpen: boolean;
    /** Main checks the host values; Save waits for it. */
    hostChecking: boolean;
    /** The last check was stopped. */
    hostCancelled: boolean;
    hostError: string | null;
  }>({
    setup: null,
    clientId: "",
    clientSecret: "",
    errors: {},
    disconnect: null,
    starting: null,
    host: { endpoint: "", bucket: "", publicBaseUrl: "", accessKeyId: "", secretAccessKey: "" },
    hostOpen: false,
    hostChecking: false,
    hostCancelled: false,
    hostError: null,
  });
  const hostTitleId = createUniqueId();
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
      draft.hostOpen = false;
      draft.hostCancelled = false;
      draft.hostError = null;
    });
  });
  const hostView = () => accounts()?.mediaHost ?? null;
  const hostConfigured = () => hostView()?.configured === true;
  let dialog: HTMLElement | undefined;
  /** The host fields that the host row sends; an empty key field keeps the saved key. */
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
    });
  };

  const hostRow = () => dialog?.querySelector<HTMLElement>(".content-media-host");
  /** The first button of the host row: Save while its fields show, else Set up or Edit. */
  const focusHostAction = () => {
    flush();
    hostRow()?.querySelector<HTMLElement>(".content-media-host-footer button, .ui-item-actions button")?.focus();
  };

  /**
   * G13: opens the host row with the saved values, scrolls to it and moves focus to its first empty field.
   * Fields that are open already keep what the user typed.
   */
  const openHost = () => {
    if (!state.hostOpen) {
      const host = hostView();
      setState((draft) => {
        draft.hostOpen = true;
        draft.hostCancelled = false;
        draft.hostError = null;
        draft.host = {
          endpoint: host?.endpoint ?? "",
          bucket: host?.bucket ?? "",
          publicBaseUrl: host?.publicBaseUrl ?? "",
          accessKeyId: "",
          secretAccessKey: "",
        };
      });
      flush();
    }
    const row = hostRow();
    row?.scrollIntoView({ block: "nearest" });
    const fields = [...(row?.querySelectorAll<HTMLInputElement>("input") ?? [])];
    (fields.find((input) => !input.value) ?? fields[0])?.focus();
  };

  // `openAccounts("instagram")` from the composer or the queue opens the host row at once, so it takes one
  // click. Only while no host is set up. The compute gives a boolean, so a reload of the accounts does not
  // open the row again over typed values.
  createEffect(
    () => props.content.state.accountsDialog?.platform === "instagram" && Boolean(accounts()) && !hostConfigured(),
    (wanted) => {
      if (!wanted) return;
      // The store is read in the frame, not in this callback (Solid 2: no store reads in an effect callback).
      requestAnimationFrame(openHost);
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
    // Each network needs the client ID of the user's own app first, some also its secret.
    const needsApp = !network.app.configured || (network.app.needsSecret && !network.app.hasSecret);
    if (needsApp && state.setup !== network.platform) {
      openSetup(network);
      return;
    }
    const clientId = state.setup === network.platform ? state.clientId.trim() : "";
    const clientSecret = state.setup === network.platform ? state.clientSecret : "";
    // The wait shows at once, so a second click cannot start, or cancel, a second sign-in.
    setState((draft) => {
      draft.setup = null;
      draft.clientSecret = "";
      draft.starting = network.platform;
    });
    // `beginConnect` ends when the sign-in ends; `connecting` shows the wait meanwhile.
    void call(network.platform, () =>
      props.content.port().content.beginConnect({
        platform: network.platform,
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
      }),
    ).finally(() =>
      setState((draft) => {
        if (draft.starting === network.platform) draft.starting = null;
      }),
    );
    void props.content.reloadAccounts();
  }

  /** Main checks the host values and saves them only when the check passes. No network or sign-in. */
  async function saveHost() {
    const mediaHost = hostInput();
    setState((draft) => {
      draft.hostChecking = true;
      draft.hostCancelled = false;
      draft.hostError = null;
    });
    try {
      props.content.setAccounts(await props.content.port().content.saveMediaHost(mediaHost));
      setState((draft) => {
        draft.hostOpen = false;
        draft.host.accessKeyId = "";
        draft.host.secretAccessKey = "";
      });
      // The Save button is gone: focus goes to the action of the row.
      focusHostAction();
    } catch (error) {
      // The IPC error keeps main's `sourceText` English at the end of its message. A stop is not an error:
      // the fields keep their values, so the user can fix one and Save again.
      const message = error instanceof Error ? error.message : String(error);
      if (message.endsWith(sourceText("error.content.mediaHostCancelled"))) {
        setState((draft) => {
          draft.hostCancelled = true;
        });
        focusHostAction();
      } else
        setState((draft) => {
          draft.hostError = errorMessage(error, t("error.content.mediaHostSaveFailed"));
        });
      void props.content.reloadAccounts();
    } finally {
      setState((draft) => {
        draft.hostChecking = false;
      });
    }
  }

  /** Stops a running check; else closes the host fields. */
  function cancelHost() {
    if (state.hostChecking) {
      // The save that waits ends with `mediaHostCancelled` and shows the caption. If this call fails, the
      // check still ends by itself at 60 seconds and shows its own result.
      void props.content
        .port()
        .content.cancelMediaHostCheck()
        .catch(() => undefined);
      return;
    }
    setState((draft) => {
      draft.hostOpen = false;
      draft.hostCancelled = false;
      draft.hostError = null;
      draft.host.accessKeyId = "";
      draft.host.secretAccessKey = "";
    });
    focusHostAction();
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
      <Dialog.Root
        open={open()}
        onOpenChange={(next) => {
          if (next) return;
          // Closing the dialog is a Cancel of the running host check.
          if (state.hostChecking) cancelHost();
          props.content.closeAccounts();
        }}
      >
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
                            data-open={
                              state.setup === network().platform || connecting() === network().platform ? "" : undefined
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
                                  <RedirectUriField network={name()} />
                                </div>
                              </Show>
                              <Show when={connecting() === network().platform}>
                                <Text variant="caption" tone="muted">
                                  {t("content.accounts.waitingHint", { network: name() })}
                                </Text>
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
                                  <Match when={account()?.status === "connected"}>
                                    <Show when={needsHost(network(), hostConfigured())}>
                                      <Button variant="outline" size="xs" onClick={openHost}>
                                        {t("content.action.setUpHost")}
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
                                  <Match when={needsHost(network(), hostConfigured())}>
                                    {/* Connect waits for the host: Instagram cannot post without it. */}
                                    <Button variant="outline" size="xs" onClick={openHost}>
                                      {t("content.action.setUpHost")}
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
                                              !state.clientSecret)))
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
                    <Item
                      role="listitem"
                      class="content-account content-media-host"
                      data-open={state.hostOpen ? "" : undefined}
                    >
                      <ItemMedia>
                        <Image class="content-network-mark" aria-hidden="true" />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle id={hostTitleId}>{t("content.accounts.mediaHost.title")}</ItemTitle>
                        <ItemDescription>
                          {hostConfigured()
                            ? t("content.accounts.mediaHost.configured")
                            : t("content.accounts.mediaHost.needed")}
                        </ItemDescription>
                        {/* Why a change of bucket is refused, before the user tries it. */}
                        <For each={hostView()?.leftover ?? []} keyed={(item) => `${item.endpointHost}/${item.bucket}`}>
                          {(item) => (
                            <ItemDescription>
                              {t("content.accounts.mediaHost.leftover", {
                                count: item().count,
                                bucket: t("content.accounts.mediaHost.bucketOn", {
                                  bucket: item().bucket,
                                  host: contentShortHost(item().endpointHost),
                                }),
                              })}
                            </ItemDescription>
                          )}
                        </For>
                        <Show when={state.hostError}>
                          {(error) => (
                            <Text tone="danger" variant="caption" role="alert">
                              {error()}
                            </Text>
                          )}
                        </Show>
                        <Show when={state.hostOpen}>
                          <fieldset
                            class="content-account-app content-account-host"
                            aria-labelledby={hostTitleId}
                            aria-busy={state.hostChecking ? "true" : undefined}
                          >
                            <Text variant="caption">{t("content.accounts.mediaHost.description")}</Text>
                            <Field label={t("content.accounts.mediaHost.endpoint")} required>
                              <Input
                                type="url"
                                value={state.host.endpoint}
                                autocomplete="off"
                                readonly={state.hostChecking}
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
                                readonly={state.hostChecking}
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
                                readonly={state.hostChecking}
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
                                readonly={state.hostChecking}
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
                                readonly={state.hostChecking}
                                onValueChange={(value) =>
                                  setState((draft) => {
                                    draft.host.secretAccessKey = value;
                                  })
                                }
                              />
                            </Field>
                          </fieldset>
                          {/* Under the fields, so a long loading label does not squeeze them. The caption sits
                              next to Save, where focus goes after a stop. */}
                          <div class="content-media-host-footer">
                            <Show when={state.hostCancelled}>
                              <Text variant="caption" tone="muted" role="status">
                                {t("content.accounts.mediaHost.cancelled")}
                              </Text>
                            </Show>
                            <Button
                              variant="outline"
                              size="xs"
                              loading={state.hostChecking}
                              loadingLabel={t("content.accounts.mediaHost.checking")}
                              disabled={hostIncomplete()}
                              onClick={() => void saveHost()}
                            >
                              {t("common.save")}
                            </Button>
                            <Button variant="ghost" size="xs" onClick={cancelHost}>
                              {t("common.cancel")}
                            </Button>
                          </div>
                        </Show>
                      </ItemContent>
                      <Show when={!state.hostOpen}>
                        <ItemActions>
                          <Button variant={hostConfigured() ? "ghost" : "outline"} size="xs" onClick={openHost}>
                            {hostConfigured() ? t("common.edit") : t("content.action.setUpHost")}
                          </Button>
                        </ItemActions>
                      </Show>
                    </Item>
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
