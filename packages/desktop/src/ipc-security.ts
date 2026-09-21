export function isTrustedDesktopIpc(
  expectedSender: object | undefined,
  expectedMainFrame: object | undefined,
  expectedOrigin: string | undefined,
  sender: object,
  frame: { readonly url: string } | null,
): boolean {
  if (!expectedSender || !expectedMainFrame || !expectedOrigin || sender !== expectedSender || frame !== expectedMainFrame) return false
  try { return new URL(frame.url).origin === expectedOrigin } catch { return false }
}
