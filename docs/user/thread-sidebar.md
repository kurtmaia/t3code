# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
Pinned threads are shown independently of their project, including when you connect to more than
one environment.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Multiple environments

When your projects live in more than one environment, the sidebar splits them into one section
per environment, headed by its name: this device first, then the others alphabetically. The icon
tells them apart: a monitor for this device, a container for a local sandbox such as WSL, and a
cloud for a remote machine. A repository you have open on two machines shows up once in each
section, so its threads never mix. Pinned threads, unsent drafts, and the Snoozed and Settled
shelves stay above or below the sections, because they are about what needs attention rather than
where it runs. With a single environment, nothing changes.

Unsent drafts with typed text or attachments appear at the top of the sidebar in both the default
and the legacy project-grouped layout. Click one to pick it back up, or hover and choose
**Discard draft**.

The legacy project-grouped layout shows the same thread details on hover and offers the same
thread menu, except for pinning, settling, and snoozing, which need the default layout.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.
