import { definePlugin, routerHook } from "@decky/api";
import { staticClasses } from "@decky/ui";
import { FaTv } from "react-icons/fa";
import { BrowsePage } from "./browse";
import { BROWSE_ROUTE, QuickAccessPanel } from "./panel";
import { disposePlayer, initPlayer } from "./player";
import { initSettings } from "./settings";

export default definePlugin(() => {
  initSettings().then(initPlayer);
  routerHook.addRoute(BROWSE_ROUTE, BrowsePage, { exact: true });

  return {
    name: "PiP Theater",
    titleView: <div className={staticClasses.Title}>PiP Theater</div>,
    content: <QuickAccessPanel />,
    icon: <FaTv />,
    onDismount() {
      routerHook.removeRoute(BROWSE_ROUTE);
      disposePlayer();
    },
  };
});
