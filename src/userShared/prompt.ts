export const confirmWithTimeout = async (
  confirm: (message: string) => Promise<boolean>,
  message: string,
  timeoutMs = 10_000
): Promise<{ confirmed: boolean; timedOut: boolean }> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<{ confirmed: boolean; timedOut: boolean }>((resolve) => {
      timer = setTimeout(() => resolve({ confirmed: false, timedOut: true }), timeoutMs);
      timer.unref();
    });
    return await Promise.race([confirm(message).then((confirmed) => ({ confirmed, timedOut: false })), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
