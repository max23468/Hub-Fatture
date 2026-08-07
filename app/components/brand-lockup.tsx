import brandMark from "../../docs/brand/assets/hub-fatture-mark.svg?url";
import brandMarkOnDark from "../../docs/brand/assets/hub-fatture-mark-on-dark.svg?url";
import { copy } from "../copy.it";

export function BrandLockup({ onDark = false }: { onDark?: boolean }) {
  return (
    <span className="brand-lockup">
      <img
        className="brand-lockup__mark"
        src={onDark ? brandMarkOnDark : brandMark}
        alt=""
        width="44"
        height="44"
      />
      <span className="brand-lockup__name">{copy.appName}</span>
    </span>
  );
}
