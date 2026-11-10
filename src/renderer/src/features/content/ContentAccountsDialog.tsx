import type { ContentAccountsState, ContentNetworkView, ContentPlatform } from "@openbot/contracts/ipc-content";
import {
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
import { createStore, For, Match, Show, Switch } from "solid-js";
import type { ContentState } from "./content-context";

/** The badge of a network, as `ProviderAccountList` maps account states. */
function accountBadge(network: ContentNetworkView) {
  if (!network.available) return { variant: "outline", key: "content.accounts.status.unavailable" } as const;
  const status = network.account?.status;
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
  }>({ setup: null, clientId: "", clientSecret: "", errors: {}, disconnect: null });
  const accounts = () => props.content.state.accounts;
  const connecting = () => accounts()?.connecting ?? null;
  const open = () => props.content.state.accountsDialog !== null;

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
    // X and LinkedIn need the client ID of the user's own app first; LinkedIn also its secret.
    const needsApp = !network.app.configured || (network.app.needsSecret && !network.app.hasSecret);
    if (needsApp && state.setup !== network.platform) {
      setState((draft) => {
        draft.setup = network.platform;
        draft.clientId = network.app.clientId ?? "";
        draft.clientSecret = "";
      });
      return;
    }
    const clientId = state.setup === network.platform ? state.clientId.trim() : "";
    const clientSecret = state.setup === network.platform ? state.clientSecret : "";
    setState((draft) => {
      draft.setup = null;
      draft.clientSecret = "";
    });
    // `beginConnect` ends when the sign-in ends; `connecting` shows the wait meanwhile.
    void call(network.platform, () =>
      props.content.port().content.beginConnect({
        platform: network.platform,
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
      }),
    );
    void props.content.reloadAccounts();
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
            <Dialog.Content as="section" class="content-accounts">
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
                  <div aria-busy="true">
                    <p class="sr-only" role="status">
                      {t("content.accounts.loading")}
                    </p>
                    <For each={[0, 1, 2]}>{() => <Skeleton class="content-skeleton-row" />}</For>
                  </div>
                }
              >
                {(current) => (
                  <ItemGroup role="list">
                    <For each={current().networks} keyed={(network) => network.platform}>
                      {(network) => {
                        const name = () => CONTENT_NETWORK_NAMES[network().platform];
                        const badge = () => accountBadge(network());
                        const account = () =>
                          network().account?.status === "revoked" ? null : (network().account ?? null);
                        return (
                          <Item
                            role="listitem"
                            class="content-account"
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
                              <Show when={state.setup === network().platform}>
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
                                      required
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
