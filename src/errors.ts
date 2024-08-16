import * as Sentry from "@sentry/node";

export function setupErrorHandler() {
  process.on("unhandledRejection", (error) => {
    console.error("Unhandled Rejection:", error);
    Sentry.captureException(error);
  });

  process.on("uncaughtException", (error) => {
    console.error("Uncaught Exception:", error);
    Sentry.captureException(error);
  });
}
