import { type ReactNode } from "react";

import {
  RIGHT_PANEL_SHEET_CLASS_NAME,
  RIGHT_PANEL_SHEET_EXPANDED_CLASS_NAME,
} from "../rightPanelLayout";
import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  children: ReactNode;
  open: boolean;
  /** Maximized: the sheet takes the whole viewport instead of a side column. */
  expanded?: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className={
          props.expanded ? RIGHT_PANEL_SHEET_EXPANDED_CLASS_NAME : RIGHT_PANEL_SHEET_CLASS_NAME
        }
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
