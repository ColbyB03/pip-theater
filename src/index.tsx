import { definePlugin, routerHook } from "@decky/api";
import { staticClasses } from "@decky/ui";
import { FaTv } from "react-icons/fa";
import { BrowsePage } from "./browse";
import { PipHost } from "./composition";
import { disposeMirror, initMirror } from "./mirror";
import { BROWSE_ROUTE, QuickAccessPanel } from "./panel";
import { disposePlayer, initPlayer } from "./player";
import { initSettings } from "./settings";

const HOST_NAME = "PipTheaterHost";

export default definePlugin(() => {
  let disposed = false;
  void initSettings().then(() => {
    if (disposed) return;
    void initPlayer();
    initMirror();
  });
  routerHook.addRoute(BROWSE_ROUTE, BrowsePage, { exact: true });
  // Mounted once, outside any page: keeps Steam's UI layer above the game while a window shows.
  routerHook.addGlobalComponent(HOST_NAME, PipHost);

  return {
    name: "PiP Theater",
    titleView: <div className={staticClasses.Title}>PiP Theater</div>,
    content: <QuickAccessPanel />,
    icon: <FaTv />,
    onDismount() {
      disposed = true;
      routerHook.removeRoute(BROWSE_ROUTE);
      routerHook.removeGlobalComponent(HOST_NAME);
      disposeMirror();
      void disposePlayer();
    },
  };
});
