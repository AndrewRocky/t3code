import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { HermesSettings } from "./settings.ts";

/** The caduceus Hermes Agent uses as its wordmark, with the strokes outlined as fills. */
export const hermesClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("hermes"),
  label: "Hermes",
  badgeLabel: "Early Access",
  settingsSchema: HermesSettings,
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#0F0F0F", dark: "#F5F5F5" },
    paths: [
      {
        d: "M11.4 6.3C9.4 4.7 6.7 4.3 4.1 5.1C6.1 6.5 8.5 7.3 11.4 7.7Z",
      },
      {
        d: "M12.6 6.3C14.6 4.7 17.3 4.3 19.9 5.1C17.9 6.5 15.5 7.3 12.6 7.7Z",
      },
      {
        d: "M10.5 3.4a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0Z",
      },
      {
        d: "M11.25 5.6a0.75 0.75 0 0 1 1.5 0V21.4a0.75 0.75 0 0 1 -1.5 0Z",
      },
      {
        d: "M11.88 8.31L10.84 8.58L9.99 9L9.34 9.55L8.9 10.23L8.75 11L8.9 11.77L9.34 12.45L9.99 13L10.84 13.42L11.88 13.69L12.68 13.9L13.25 14.18L13.62 14.48L13.8 14.76L13.85 15L13.8 15.24L13.62 15.52L13.25 15.82L12.68 16.1L11.88 16.31A0.7 0.7 0 0 1 12.12 17.69L13.16 17.42L14.01 17L14.66 16.45L15.1 15.77L15.25 15L15.1 14.23L14.66 13.55L14.01 13L13.16 12.58L12.12 12.31L11.32 12.1L10.75 11.82L10.38 11.52L10.2 11.24L10.15 11L10.2 10.76L10.38 10.48L10.75 10.18L11.32 9.9L12.12 9.69A0.7 0.7 0 0 1 11.88 8.31Z",
      },
      {
        d: "M11.88 9.69L12.68 9.9L13.25 10.18L13.62 10.48L13.8 10.76L13.85 11L13.8 11.24L13.62 11.52L13.25 11.82L12.68 12.1L11.88 12.31L10.84 12.58L9.99 13L9.34 13.55L8.9 14.23L8.75 15L8.9 15.77L9.34 16.45L9.99 17L10.84 17.42L11.88 17.69A0.7 0.7 0 0 1 12.12 16.31L11.32 16.1L10.75 15.82L10.38 15.52L10.2 15.24L10.15 15L10.2 14.76L10.38 14.48L10.75 14.18L11.32 13.9L12.12 13.69L13.16 13.42L14.01 13L14.66 12.45L15.1 11.77L15.25 11L15.1 10.23L14.66 9.55L14.01 9L13.16 8.58L12.12 8.31A0.7 0.7 0 0 1 11.88 9.69Z",
      },
    ],
  },
});
