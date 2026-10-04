import type { MetadataRoute } from "next";

// Lets the app be added to a phone's home screen and opened without browser
// chrome. Colours match --surface and --plane in globals.css.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "JalLog",
    short_name: "JalLog",
    description: "Paper STP and ETP logbooks, read from a photo, checked by a person beside the photo and then by fixed rules.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f6f6f3",
    theme_color: "#fcfcfb",
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any", purpose: "any" },
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any", purpose: "maskable" },
    ],
  };
}
