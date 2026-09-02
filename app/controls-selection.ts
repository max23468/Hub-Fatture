import { useLayoutEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";

export function useControlsSelection({
  hasExplicitSelection,
  selectedControlId,
  listLink,
}: {
  hasExplicitSelection: boolean;
  selectedControlId: string;
  listLink: string;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const selectionScrollRef = useRef<number | null>(null);
  const listScrollRef = useRef<number | null>(null);
  const lastSelectedIdRef = useRef<string | null>(selectedControlId || null);
  const detailWasOpenRef = useRef(false);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement | null>(null);

  useLayoutEffect(() => {
    const compact = window.matchMedia("(max-width: 64rem)").matches;
    if (!compact) {
      if (selectionScrollRef.current === null) return;
      const scrollPosition = selectionScrollRef.current;
      selectionScrollRef.current = null;
      window.scrollTo(0, scrollPosition);
      let frame = 0;
      let remainingFrames = 3;
      const restoreScroll = () => {
        window.scrollTo(0, scrollPosition);
        remainingFrames -= 1;
        if (remainingFrames > 0) frame = window.requestAnimationFrame(restoreScroll);
      };
      frame = window.requestAnimationFrame(restoreScroll);
      return () => window.cancelAnimationFrame(frame);
    }

    if (hasExplicitSelection) {
      detailWasOpenRef.current = true;
      lastSelectedIdRef.current = selectedControlId;
      selectionScrollRef.current = null;
      window.scrollTo(0, 0);
      const frame = window.requestAnimationFrame(() => {
        window.scrollTo(0, 0);
        detailHeadingRef.current?.focus({ preventScroll: true });
      });
      return () => window.cancelAnimationFrame(frame);
    }

    if (!detailWasOpenRef.current) return;
    detailWasOpenRef.current = false;
    selectionScrollRef.current = null;
    const scrollPosition = listScrollRef.current;
    listScrollRef.current = null;
    const selectedId = lastSelectedIdRef.current;
    let frame = 0;
    let remainingFrames = scrollPosition === null ? 1 : 3;
    const restoreScroll = () => {
      if (scrollPosition !== null) window.scrollTo(0, scrollPosition);
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        frame = window.requestAnimationFrame(restoreScroll);
        return;
      }
      if (!selectedId) return;
      const row = workspaceRef.current?.querySelector<HTMLAnchorElement>(
        `[data-control-id="${CSS.escape(selectedId)}"]`,
      );
      row?.focus({ preventScroll: scrollPosition !== null });
    };
    frame = window.requestAnimationFrame(restoreScroll);
    return () => window.cancelAnimationFrame(frame);
  }, [hasExplicitSelection, selectedControlId]);

  const rememberSelection = (controlId: string) => {
    selectionScrollRef.current = window.scrollY;
    listScrollRef.current = window.scrollY;
    lastSelectedIdRef.current = controlId;
  };
  const cameFromControlsList = Boolean(
    (location.state as { fromControlsList?: boolean } | null)?.fromControlsList,
  );
  const returnToList = () => {
    if (cameFromControlsList) {
      void navigate(-1);
      return;
    }
    void navigate(listLink, { preventScrollReset: true, replace: true });
  };

  return { detailHeadingRef, rememberSelection, returnToList, workspaceRef };
}
