-- What the notifier told Slack about, once each, and the message's id, which is also its thread's.
CREATE TABLE "SlackNotice" (
    "ref" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "ts" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlackNotice_pkey" PRIMARY KEY ("ref")
);
