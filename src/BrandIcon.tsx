import darkIcon from "../resources/rcf-app-dark.png";
import lightIcon from "../resources/rcf-app-light.png";
import { useApp } from "./store";

export function BrandIcon({
  className = "",
  alt = "",
}: {
  className?: string;
  alt?: string;
}) {
  const theme = useApp((state) => state.preferences.theme);
  return (
    <img
      className={className}
      src={theme === "light" ? lightIcon : darkIcon}
      alt={alt}
    />
  );
}
