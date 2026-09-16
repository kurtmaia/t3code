/**
 * Sub-thread draft sheet: the quoted assistant passage plus one question
 * input. Nothing exists on the server while drafting — the sub-thread is
 * created on send (create → first turn), mirroring the web SubThreadPanel and
 * the implement-plan-in-new-thread flow, and rolled back if the first turn
 * fails. On success the sheet closes and the new thread opens.
 */
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  buildSubThreadCreation,
  buildSubThreadSeedPrompt,
  truncateQuote,
} from "@t3tools/client-runtime/state/subThreads";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, MessageId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useMemo, useRef, useState } from "react";
import { Alert, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { uuidv4 } from "../../lib/uuid";
import { useThemeColor } from "../../lib/useThemeColor";
import { appAtomRegistry } from "../../state/atom-registry";
import { useThreadShell } from "../../state/entities";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { SheetActionButton } from "./git/gitSheetComponents";

type AtomCommandFailure = Extract<AtomCommandResult<unknown, unknown>, { _tag: "Failure" }>;

/** Best-effort wait for the created sub-thread's shell so the thread screen
    opens ready instead of flashing its unavailable state. Mirrors web's
    waitForStartedServerThread: a timeout still navigates — the shell is
    already on its way. */
function waitForThreadShell(ref: ScopedThreadRef, timeoutMs = 2_000): Promise<boolean> {
  const shellAtom = environmentThreadShells.threadShellAtom(ref);
  if (appAtomRegistry.get(shellAtom) !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };
    const unsubscribe = appAtomRegistry.subscribe(shellAtom, (shell) => {
      if (shell !== null) {
        finish(true);
      }
    });
    if (appAtomRegistry.get(shellAtom) !== null) {
      finish(true);
      return;
    }
    timeoutId = setTimeout(() => finish(false), timeoutMs);
  });
}

export function SubThreadDraftScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly parentThreadId: ThreadId;
  readonly parentMessageId: MessageId;
  readonly quoteText: string;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const iconSubtleColor = useThemeColor("--color-icon-subtle");

  const parentThreadRef = useMemo(
    () => ({ environmentId: props.environmentId, threadId: props.parentThreadId }),
    [props.environmentId, props.parentThreadId],
  );
  const parentShell = useThreadShell(parentThreadRef);

  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });

  const [question, setQuestion] = useState("");
  const [isSending, setIsSending] = useState(false);
  const sendInFlightRef = useRef(false);

  const onSend = useCallback(async () => {
    const trimmedQuestion = question.trim();
    if (trimmedQuestion.length === 0 || sendInFlightRef.current || parentShell === null) {
      return;
    }
    sendInFlightRef.current = true;
    setIsSending(true);
    const finish = () => {
      sendInFlightRef.current = false;
      setIsSending(false);
    };

    const environmentId = props.environmentId;
    const nextThreadId = ThreadId.make(uuidv4());
    const quote = {
      messageId: props.parentMessageId,
      text: truncateQuote(props.quoteText),
    };
    const { createInput, startInput } = buildSubThreadCreation({
      threadId: nextThreadId,
      messageId: MessageId.make(uuidv4()),
      parent: parentShell,
      quote,
      promptText: buildSubThreadSeedPrompt({ quoteText: quote.text, question: trimmedQuestion }),
      modelSelection: parentShell.modelSelection,
      runtimeMode: parentShell.runtimeMode,
      interactionMode: parentShell.interactionMode,
      createdAt: new Date().toISOString(),
    });

    const createResult = await createThread({ environmentId, input: createInput });
    let failure: AtomCommandFailure | null = createResult._tag === "Failure" ? createResult : null;
    if (failure === null) {
      const startResult = await startThreadTurn({ environmentId, input: startInput });
      failure = startResult._tag === "Failure" ? startResult : null;
    }

    if (failure !== null) {
      // A failed question must not leave an empty thread behind.
      const cleanupResult = await deleteThread({
        environmentId,
        input: { threadId: nextThreadId },
      });
      if (cleanupResult._tag === "Failure" && !isAtomCommandInterrupted(cleanupResult)) {
        console.warn(
          "Failed to clean up sub-thread after start failure.",
          squashAtomCommandFailure(cleanupResult),
        );
      }
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        Alert.alert(
          "Could not start side conversation",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "An error occurred while creating the side conversation.",
        );
      }
      finish();
      return;
    }

    await waitForThreadShell({ environmentId, threadId: nextThreadId });
    finish();
    // Close the sheet, then push the new thread over the parent so the back
    // gesture returns there (navigate would retarget the parent's route).
    navigation.goBack();
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId: String(environmentId),
        threadId: String(nextThreadId),
      }),
    );
  }, [
    createThread,
    deleteThread,
    navigation,
    parentShell,
    props.environmentId,
    props.parentMessageId,
    props.quoteText,
    question,
    startThreadTurn,
  ]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <AndroidSheetHeader title="Ask about this" onBack={() => navigation.goBack()} />
      ) : null}
      <ScrollView
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerClassName="gap-4 px-5 pt-4"
      >
        {Platform.OS !== "android" ? (
          <Text className="text-center text-base font-t3-bold text-foreground">Ask about this</Text>
        ) : null}

        {parentShell === null ? (
          <EmptyState
            title="Parent thread unavailable"
            detail="The thread this passage came from is not available right now."
          />
        ) : (
          <>
            <View className="rounded-[22px] border border-border bg-card px-4 py-3.5">
              <View className="flex-row items-start gap-2.5">
                <View className="mt-0.5">
                  <SymbolView
                    name="text.quote"
                    size={13}
                    tintColor={iconSubtleColor}
                    type="monochrome"
                  />
                </View>
                <Text
                  className="min-w-0 flex-1 text-sm leading-snug text-foreground-secondary"
                  numberOfLines={6}
                >
                  {props.quoteText}
                </Text>
              </View>
            </View>

            <TextInput
              autoFocus
              multiline
              value={question}
              onChangeText={setQuestion}
              placeholder="Ask about this passage…"
              textAlignVertical="top"
              className="min-h-[96px] rounded-[20px] px-4 py-3.5"
            />

            <SheetActionButton
              icon="arrow.up"
              label={isSending ? "Starting…" : "Ask"}
              tone="primary"
              disabled={question.trim().length === 0 || isSending}
              onPress={() => void onSend()}
            />
            <Text className="text-center text-xs leading-normal text-foreground-tertiary">
              The side conversation uses the parent thread's mode and workspace.
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

type SubThreadDraftRouteParams = {
  readonly environmentId?: string | string[];
  readonly threadId?: string | string[];
  readonly messageId?: string | string[];
  readonly quote?: string | string[];
};

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

export function SubThreadDraftRouteScreen({ route }: StaticScreenProps<SubThreadDraftRouteParams>) {
  const params = route.params ?? {};
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const threadIdRaw = firstRouteParam(params.threadId);
  const messageIdRaw = firstRouteParam(params.messageId);
  const quoteRaw = firstRouteParam(params.quote);
  // Deep links can arrive malformed; the contract caps quotes at 500 chars,
  // so re-truncate rather than trusting the URL.
  const quoteText = truncateQuote(quoteRaw ?? "");

  if (environmentIdRaw === null || threadIdRaw === null || messageIdRaw === null) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-6">
        <EmptyState
          title="Nothing to ask about"
          detail="This side-conversation link is missing its source message."
        />
      </View>
    );
  }

  return (
    <SubThreadDraftScreen
      environmentId={EnvironmentId.make(environmentIdRaw)}
      parentThreadId={ThreadId.make(threadIdRaw)}
      parentMessageId={MessageId.make(messageIdRaw)}
      quoteText={quoteText}
    />
  );
}
