import { checkNativeInvitation, NativeInvitationError, parseNativeInvitation } from "./native-invite.js";

const status = document.getElementById("status");
const refresh = document.getElementById("refresh");
const handoff = document.getElementById("handoff");
const address = document.getElementById("invitation");
if (
  !status || !(refresh instanceof HTMLButtonElement) || !handoff ||
  !(address instanceof HTMLInputElement)
) {
  throw new Error("Missing native invitation view");
}
const statusView = status;
const refreshButton = refresh;
const handoffView = handoff;
const invitationView = address;

async function check() {
  refreshButton.disabled = true;
  handoffView.hidden = true;
  statusView.textContent = "Checking invitation…";
  try {
    const invitation = parseNativeInvitation(new URL(
      location.search + location.hash, "https://moenarch.com/native.html",
    ));
    invitationView.value = invitation.url;
    // Production always uses its own setup service; invitation input cannot
    // choose another endpoint or executable.
    statusView.textContent = await checkNativeInvitation(invitation, location.origin);
    handoffView.hidden = false;
  } catch (error) {
    statusView.textContent = error instanceof NativeInvitationError
      ? error.message
      : "Cannot reach the lobby service. Check your connection and try again.";
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", () => void check());
void check();
