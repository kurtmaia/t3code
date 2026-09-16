export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)";
/**
 * A side column on a tablet-sized window, the whole screen on a phone: below
 * 760px the leftover strip of chat is too narrow to read or aim at, so it only
 * costs the panel room it needs.
 */
export const RIGHT_PANEL_SHEET_CLASS_NAME =
  "w-[min(42vw,28rem)] min-w-80 max-w-[28rem] p-0 max-[760px]:w-full max-[760px]:min-w-0 max-[760px]:max-w-none wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]";
/**
 * The sheet while the panel is maximized. Narrow viewports are where a file or
 * a rendered document gets squeezed into an unreadable column, so maximizing
 * here means the whole viewport rather than merely wider.
 */
export const RIGHT_PANEL_SHEET_EXPANDED_CLASS_NAME =
  "w-full min-w-0 max-w-none p-0 wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]";
