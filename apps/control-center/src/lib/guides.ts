export const GUIDE_SLUGS = [
    "quick-start",
    "monitors",
    "notifications",
    "account",
    "troubleshooting",
] as const;
export type GuideSlug = (typeof GUIDE_SLUGS)[number];
export type GuidePlacement = "app" | "public";
export type GuideArticle = {
    id: string;
    title: string;
    summary: string;
    steps: { title: string; detail: string }[];
    result: string;
    note?: string;
    image?: {
        src: string;
        darkSrc: string;
        alt: string;
        caption: string;
        width: number;
        height: number;
    };
    action?: { label: string; href: string };
    related?: { topic: GuideSlug; article: string; label: string }[];
};
export type GuideTopic = {
    slug: GuideSlug;
    label: string;
    title: string;
    description: string;
    articles: GuideArticle[];
};

export const GUIDE_TOPICS: readonly GuideTopic[] = [
    {
        slug: "quick-start",
        label: "Quick start",
        title: "Set up your first Vinted monitor",
        description:
            "Go from a saved Vinted search to a running monitor and your first Discord or Telegram alert.",
        articles: [
            {
                id: "first-monitor",
                title: "Create your first monitor",
                summary:
                    "Start with one specific search. Add more filters once you have checked that the results are useful.",
                steps: [
                    {
                        title: "Open New Monitor",
                        detail: "Give the monitor a name you will recognize in your feed and notifications, such as Vintage jackets.",
                    },
                    {
                        title: "Choose your search and marketplace",
                        detail: "Enter a search query or import a Vinted search URL. Check the region after importing: it controls the marketplace, available sizes, and currency.",
                    },
                    {
                        title: "Keep your first filters simple",
                        detail: "Try a query and maximum price first. Add brand, category, size, or condition filters when you need more precise results.",
                    },
                    {
                        title: "Select a proxy source",
                        detail: "Choose a Ready Free Pool region if available, or select your own verified proxy group. Shared pool availability can change.",
                    },
                    {
                        title: "Choose your alert destination",
                        detail: "Open Notifications and add a Discord webhook or enable your connected Telegram chat. You can also inspect matches in the live feed.",
                    },
                    {
                        title: "Create and check the monitor",
                        detail: "Select Create Monitor, then check its status and item feed. If it was saved paused, review the displayed reason before starting it.",
                    },
                ],
                result: "The monitor is saved with the intended region, filters, and proxy source. Once checks succeed, matching new listings can appear in its feed.",
                image: {
                    src: "/guides/monitor-basics.png",
                    darkSrc: "/guides/monitor-basics-dark.png",
                    alt: "The Vintrack monitor form with an example monitor name, search query, and region controls.",
                    caption:
                        "Example setup using sample data. Choose the marketplace where you want to search.",
                    width: 862,
                    height: 1019,
                },
                action: { label: "Create monitor", href: "/monitors/new" },
                related: [
                    {
                        topic: "monitors",
                        article: "proxies",
                        label: "Choose a proxy source",
                    },
                    {
                        topic: "notifications",
                        article: "discord",
                        label: "Set up Discord alerts",
                    },
                ],
            },
            {
                id: "first-alert",
                title: "Check your first alert",
                summary:
                    "Verify the destination separately from the search so you know which part of the setup to adjust.",
                steps: [
                    {
                        title: "Send a test",
                        detail: "Use Test next to your Discord webhook. For Telegram, use its test action after connecting your chat in Dashboard settings.",
                    },
                    {
                        title: "Enable alerts for the monitor",
                        detail: "Check that monitor notifications and your chosen delivery channel are enabled, then save the settings.",
                    },
                    {
                        title: "Compare the feed and destination",
                        detail: "When a new matching listing appears, check its monitor name, price, size, and item link in the feed and your connected channel.",
                    },
                ],
                result: "The test reaches the expected destination, and new matching items can be delivered by the enabled monitor.",
                note: "A successful test confirms the destination works. It does not confirm that your search currently has new matching listings.",
                action: { label: "Open monitors", href: "/dashboard" },
                related: [
                    {
                        topic: "troubleshooting",
                        article: "no-alerts",
                        label: "Fix missing notifications",
                    },
                ],
            },
        ],
    },
    {
        slug: "monitors",
        label: "Monitors",
        title: "Build searches that find the right items",
        description:
            "Understand search imports, filters, quiet hours, proxy sources, and the difference between a monitor and a Price Watch.",
        articles: [
            {
                id: "search-and-filters",
                title: "Import a search and refine its filters",
                summary:
                    "Use a search you have already checked on Vinted as a starting point.",
                steps: [
                    {
                        title: "Import the Vinted search URL",
                        detail: "Copy the search page URL into Import Vinted search and apply it. Review the imported query, region, and selected filters before creating the monitor.",
                    },
                    {
                        title: "Choose how the query should match",
                        detail: "Use a specific query. Comma-separated alternatives are rotated at the configured polling rate. Enable title-only matching when the words must appear in the listing title.",
                    },
                    {
                        title: "Add exclusions",
                        detail: "Use anti-keywords for recurring unwanted results. Check a few listings before excluding a word that could also appear in items you want.",
                    },
                    {
                        title: "Narrow the results deliberately",
                        detail: "Add price, category, brand, size, color, or condition filters. Seller-country and seller-quality filters further restrict which results reach you; they are separate from the Vinted marketplace region.",
                    },
                    {
                        title: "Review the preview",
                        detail: "Open the generated Vinted URL to compare the search with the monitor configuration. If results disappear, remove filters one at a time.",
                    },
                ],
                result: "Your saved monitor represents the intended search, and you can explain why each filter is enabled.",
                action: { label: "Create monitor", href: "/monitors/new" },
                related: [
                    {
                        topic: "troubleshooting",
                        article: "no-matches",
                        label: "Check a search with no matches",
                    },
                ],
            },
            {
                id: "quiet-hours",
                title: "Set quiet hours",
                summary:
                    "Reduce monitoring activity during a daily window without rebuilding the monitor each time.",
                steps: [
                    {
                        title: "Open the monitor settings",
                        detail: "Expand Quiet Hours and enable the schedule.",
                    },
                    {
                        title: "Set the time window and timezone",
                        detail: "Choose the start and end times and check the timezone. A window can continue across midnight.",
                    },
                    {
                        title: "Choose what happens during the window",
                        detail: "Pause checking or use the slower polling option. Save the monitor, then review the schedule shown in its settings.",
                    },
                ],
                result: "The saved schedule controls when that monitor checks for listings and when it returns to its normal interval.",
                note: "Quiet hours affect monitoring. To stop a particular notification channel, use its notification controls.",
                action: { label: "Open monitors", href: "/dashboard" },
            },
            {
                id: "proxies",
                title: "Choose and verify a proxy source",
                summary:
                    "The proxy source supplies the connection used to check a Vinted marketplace.",
                steps: [
                    {
                        title: "Check regional availability",
                        detail: "Open Proxy Groups or the monitor's Proxy Source section. A Ready Free Pool region can be selected when that feature is available for your account.",
                    },
                    {
                        title: "Add a personal group if needed",
                        detail: "Add one proxy per line in Proxy Groups using a supported URL or host:port:user:password format. Use a recognizable group name.",
                    },
                    {
                        title: "Verify the intended region",
                        detail: "Run the group's proxy check against the same marketplace region as your monitor. Review working proxies and any bandwidth allowance.",
                    },
                    {
                        title: "Save the selected source",
                        detail: "Select the source in the monitor settings and save. Choose a polling interval that your source can sustain.",
                    },
                ],
                result: "The monitor uses a source that is available for its selected marketplace.",
                note: "The Free Pool is shared and best-effort. A Checking region is not ready for new monitors. Account actions use a separate linked-account connection.",
                action: { label: "Open proxy groups", href: "/proxies" },
                related: [
                    {
                        topic: "troubleshooting",
                        article: "pool-unavailable",
                        label: "When a pool is unavailable",
                    },
                ],
            },
            {
                id: "price-watches",
                title: "Track a price drop on one item",
                summary:
                    "Use a monitor to discover new listings. Use a Price Watch to follow the price of a specific listing you already found.",
                steps: [
                    {
                        title: "Copy the listing URL",
                        detail: "Use the Vinted item page URL rather than a search or member profile URL.",
                    },
                    {
                        title: "Open Price Watch and select Add watch",
                        detail: "Paste the item URL. Check that it identifies the intended item and marketplace.",
                    },
                    {
                        title: "Choose the checking source and interval",
                        detail: "Select Vintrack Shared or an eligible personal proxy group. The available intervals depend on the source and its regional verification.",
                    },
                    {
                        title: "Enable a destination and save",
                        detail: "Choose Discord, Telegram, or both. Reuse a saved Discord webhook if appropriate, then add the watch.",
                    },
                    {
                        title: "Wait for the starting price",
                        detail: "The first successful check establishes the baseline. Later confirmed decreases can trigger alerts. Review the watch's status and price history.",
                    },
                ],
                result: "The item has a saved starting price and an active watch for subsequent price decreases.",
                note: "A sold, removed, or unavailable item can stop being watched. Review the displayed status before trying to restart it.",
                action: { label: "Open Price Watch", href: "/price-watches" },
            },
        ],
    },
    {
        slug: "notifications",
        label: "Notifications",
        title: "Connect Discord and Telegram alerts",
        description:
            "Create a Discord webhook, reuse saved destinations, connect Telegram, and check your notification settings.",
        articles: [
            {
                id: "discord",
                title: "Set up Discord notifications",
                summary:
                    "A webhook sends alerts to a Discord channel you manage. Signing in with Discord does not automatically connect that channel.",
                steps: [
                    {
                        title: "Create a Discord webhook",
                        detail: "In Discord, open your server's Settings, then Integrations and Webhooks. Create a webhook, select the destination channel, and copy its webhook URL.",
                    },
                    {
                        title: "Open the monitor's Notifications section",
                        detail: "Paste the URL into Discord Webhook. When editing from the monitor list, open that monitor's notification settings.",
                    },
                    {
                        title: "Reuse a saved destination when available",
                        detail: "Choose an entry under Saved Discord webhooks to fill the URL automatically. New destinations are remembered for your account when you save.",
                    },
                    {
                        title: "Send a test",
                        detail: "Select Test and confirm the message appears in the intended Discord channel.",
                    },
                    {
                        title: "Save and enable delivery",
                        detail: "Save the monitor or notification dialog. Check that Discord delivery and monitor notifications are enabled.",
                    },
                ],
                result: "The test arrives in the expected Discord channel, and the saved monitor can send new matching-item alerts there.",
                image: {
                    src: "/guides/monitor-notifications.png",
                    darkSrc: "/guides/monitor-notifications-dark.png",
                    alt: "The monitor Notifications section with the Discord webhook field, Test button, and Telegram controls.",
                    caption:
                        "Configure and test the destination before saving. The example contains no live webhook.",
                    width: 862,
                    height: 314,
                },
                note: "A webhook URL grants access to post in its channel. Keep it private. You do not need to append /github to a webhook used by Vintrack.",
                action: { label: "Open monitors", href: "/dashboard" },
                related: [
                    {
                        topic: "troubleshooting",
                        article: "no-alerts",
                        label: "Fix missing Discord alerts",
                    },
                ],
            },
            {
                id: "telegram",
                title: "Connect your Telegram chat",
                summary:
                    "Use the connection command generated by Vintrack. You do not need to enter a bot token or numeric chat ID.",
                steps: [
                    {
                        title: "Open Dashboard settings",
                        detail: "Use the gear button on the monitor dashboard and find the Telegram connection controls.",
                    },
                    {
                        title: "Generate a connection code",
                        detail: "Choose Connect Telegram and copy the command Vintrack displays. Open the linked Telegram bot.",
                    },
                    {
                        title: "Send the generated command",
                        detail: "Send that command in the Telegram chat you want to connect. Return to Vintrack and wait for the connection status to update.",
                    },
                    {
                        title: "Enable Telegram for the monitor",
                        detail: "Open the monitor's Notifications section, enable Telegram, and save. Use the test action to check delivery.",
                    },
                ],
                result: "Vintrack shows a connected Telegram chat and the monitor has Telegram delivery enabled.",
                note: "If a connection code expires, generate a new command. On a self-hosted instance, the operator must configure the Telegram bot first.",
                action: {
                    label: "Open Dashboard settings",
                    href: "/dashboard",
                },
            },
            {
                id: "message-styles",
                title: "Choose Rich or Compact alerts",
                summary:
                    "Control how much information each destination displays without changing your search.",
                steps: [
                    {
                        title: "Open Dashboard settings",
                        detail: "Find the Discord and Telegram message-style controls.",
                    },
                    {
                        title: "Choose a style for each channel",
                        detail: "Use Rich for a larger presentation or Compact for a smaller preview. Each channel's choice is independent and applies across your account.",
                    },
                    {
                        title: "Review a test message",
                        detail: "Send a test to check readability on the device where you normally read alerts.",
                    },
                ],
                result: "Each enabled destination uses your preferred message style for future alerts.",
                action: {
                    label: "Open Dashboard settings",
                    href: "/dashboard",
                },
            },
        ],
    },
    {
        slug: "account",
        label: "Account & extension",
        title: "Connect your Vinted account and browser extension",
        description:
            "Install the browser extension, link your own Vinted session, and understand when account actions need a connection.",
        articles: [
            {
                id: "browser-extension",
                title: "Install the browser extension",
                summary:
                    "Monitoring and alerts do not require a linked Vinted account. Install the extension when you want to use account actions.",
                steps: [
                    {
                        title: "Open Account",
                        detail: "Use the extension installation links provided by your Vintrack instance. Firefox can use the linked Add-ons listing; Chrome uses the downloadable extension package.",
                    },
                    {
                        title: "Install the Chrome package if using Chrome",
                        detail: "Extract the downloaded ZIP. Open chrome://extensions, enable Developer mode, choose Load unpacked, and select the extracted folder that contains manifest.json.",
                    },
                    {
                        title: "Check the Vintrack address",
                        detail: "For a self-hosted instance, use the extension build configured for that instance's address. The standard hosted build does not automatically trust every private deployment.",
                    },
                ],
                result: "The extension is installed in the same browser you will use for both Vinted and Vintrack.",
                action: { label: "Open Account", href: "/account" },
                related: [
                    {
                        topic: "account",
                        article: "link-account",
                        label: "Link the browser session",
                    },
                ],
            },
            {
                id: "link-account",
                title: "Link or refresh your Vinted session",
                summary:
                    "Connect an account you control through the installed browser extension.",
                steps: [
                    {
                        title: "Sign in to Vinted",
                        detail: "Open your intended Vinted marketplace in the browser where the extension is installed, and sign in to the account you want to connect.",
                    },
                    {
                        title: "Open Account in Vintrack",
                        detail: "Choose Link With Installed Extension and follow the connection prompts.",
                    },
                    {
                        title: "Confirm the connection",
                        detail: "Check the displayed Vinted account and domain before using account actions.",
                    },
                    {
                        title: "Relink when necessary",
                        detail: "If the connection expires, sign in to Vinted again and repeat the extension linking flow. Check the browser's extension permissions if Vintrack cannot detect it.",
                    },
                ],
                result: "Account shows the intended linked Vinted identity and marketplace.",
                note: "Vintrack does not need your Vinted password in a form or support message. The extension connection supplies the session information needed for linked actions.",
                action: { label: "Open Account", href: "/account" },
            },
            {
                id: "account-actions",
                title: "Use likes, offers, messages, and checkout",
                summary:
                    "Available item actions depend on your linked session, instance configuration, and enabled features.",
                steps: [
                    {
                        title: "Check the linked account",
                        detail: "Confirm the account and marketplace in Account before using an item action.",
                    },
                    {
                        title: "Choose an action on an item",
                        detail: "Use the item's Like, Offer, or Message action. Review the amount or message before confirming.",
                    },
                    {
                        title: "Follow the checkout flow shown by your instance",
                        detail: "Checkout features can require additional setup and confirmation. Review the item, total price, delivery, and payment details before authorizing a purchase.",
                    },
                ],
                result: "You know which account performs the action and can review its result in Vintrack or Vinted.",
                action: { label: "Open live feed", href: "/feed" },
            },
        ],
    },
    {
        slug: "troubleshooting",
        label: "Troubleshooting",
        title: "Find out why a monitor or alert is not working",
        description:
            "Work through missing matches, delivery problems, unavailable proxy pools, paused monitors, and account connections.",
        articles: [
            {
                id: "no-matches",
                title: "The monitor has no matching items",
                summary:
                    "Start with the monitor's status and search. Change one setting at a time so you can identify the cause.",
                steps: [
                    {
                        title: "Check whether it is running",
                        detail: "Review the status and any pause or error reason. Check quiet hours and the selected timezone before changing the search.",
                    },
                    {
                        title: "Check the marketplace",
                        detail: "Open the generated Vinted search URL. Confirm the region, query, and currency are the ones you intended.",
                    },
                    {
                        title: "Loosen restrictive filters",
                        detail: "Temporarily remove seller-country, seller-quality, size, and condition filters. Check anti-keywords and title-only matching too.",
                    },
                    {
                        title: "Check the connection source",
                        detail: "Review regional Free Pool readiness or verify your personal group against the same region. Fix connection errors before increasing the checking frequency.",
                    },
                    {
                        title: "Review new results",
                        detail: "Save the adjusted search and watch the monitor feed. If results return, restore filters one at a time.",
                    },
                ],
                result: "You have isolated whether the problem is the search, schedule, monitor status, or connection source.",
                action: { label: "Check your monitors", href: "/dashboard" },
                related: [
                    {
                        topic: "monitors",
                        article: "search-and-filters",
                        label: "Review search filters",
                    },
                ],
            },
            {
                id: "no-alerts",
                title: "Items appear in the feed but no alert arrives",
                summary:
                    "If an item is already in the feed, check delivery settings before changing the search filters.",
                steps: [
                    {
                        title: "Check the monitor's notification switches",
                        detail: "Enable notifications for the monitor and the individual Discord or Telegram channel, then save.",
                    },
                    {
                        title: "Test Discord independently",
                        detail: "Open the saved webhook and send a test. Check the destination channel; replace the webhook if it was deleted or regenerated in Discord.",
                    },
                    {
                        title: "Check Telegram's connection",
                        detail: "Confirm that Dashboard settings shows a connected chat. Reconnect with a new command if needed, then enable Telegram on the monitor.",
                    },
                    {
                        title: "Review timing and duplicate handling",
                        detail: "Check whether the item arrived before alerts were enabled and whether account-wide duplicate-alert suppression is enabled. Test delivery with a new matching item.",
                    },
                ],
                result: "You know whether the destination is reachable and the monitor is configured to send future alerts to it.",
                action: { label: "Open monitors", href: "/dashboard" },
                related: [
                    {
                        topic: "notifications",
                        article: "discord",
                        label: "Set up Discord again",
                    },
                    {
                        topic: "notifications",
                        article: "telegram",
                        label: "Reconnect Telegram",
                    },
                ],
            },
            {
                id: "pool-unavailable",
                title: "The Free Pool region is not Ready",
                summary:
                    "A shared pool needs enough healthy regional connections before it can accept new monitors.",
                steps: [
                    {
                        title: "Read the regional status",
                        detail: "Checking or unavailable is different from Ready. Confirm that you are viewing the region selected on your monitor.",
                    },
                    {
                        title: "Choose an available source",
                        detail: "Wait for regional readiness or use a personal proxy group verified for the intended marketplace.",
                    },
                    {
                        title: "Check again before saving",
                        detail: "Return to the monitor's Proxy Source section and confirm that the source can be selected.",
                    },
                ],
                result: "You have a usable source for the intended marketplace, or know that the shared pool is still recovering.",
                action: { label: "Check proxy availability", href: "/proxies" },
            },
            {
                id: "paused-monitor",
                title: "A monitor was saved or left paused",
                summary:
                    "A saved configuration can remain paused when a resource limit or maintenance setting prevents it from starting.",
                steps: [
                    {
                        title: "Read the displayed reason",
                        detail: "Check for maintenance, an account-wide active-monitor limit, a Free Pool allowance, or a personal-proxy limit.",
                    },
                    {
                        title: "Review the relevant allowance",
                        detail: "Open Account for GitHub rewards or inspect proxy usage for a personal group. Allowances depend on the instance's configuration; changing a reward does not automatically restart monitors.",
                    },
                    {
                        title: "Start it when capacity is available",
                        detail: "Pause another monitor if appropriate or select another permitted source. Start the monitor manually once the blocking condition is resolved.",
                    },
                ],
                result: "The monitor starts when permitted, or remains safely saved with a clear reason for being paused.",
                action: { label: "Review your account", href: "/account" },
            },
            {
                id: "account-connection",
                title: "The extension or linked account is not detected",
                summary:
                    "Check browser installation and the Vintrack address before trying the account action again.",
                steps: [
                    {
                        title: "Use the same browser",
                        detail: "Open Vinted and Vintrack in the browser where the extension is installed and enabled.",
                    },
                    {
                        title: "Check the extension's supported address",
                        detail: "A self-hosted Vintrack address needs an extension configured for that address. Follow the instance's extension installation instructions.",
                    },
                    {
                        title: "Refresh the connection",
                        detail: "Sign in to the intended Vinted account, reload Vintrack, and choose Link With Installed Extension in Account.",
                    },
                ],
                result: "Vintrack can detect the extension and show the intended linked account, or you have identified an installation or address mismatch.",
                action: { label: "Open Account", href: "/account" },
                related: [
                    {
                        topic: "account",
                        article: "browser-extension",
                        label: "Install the extension",
                    },
                ],
            },
        ],
    },
];

export const PUBLIC_GUIDE_PATHS = GUIDE_SLUGS.map(
    (slug) => `/guides/${slug}` as const,
);

export function getGuideTopic(slug: string) {
    return GUIDE_TOPICS.find((topic) => topic.slug === slug);
}

export function guideHref(
    placement: GuidePlacement,
    slug: GuideSlug,
    article?: string,
) {
    const path =
        placement === "public"
            ? `/guides/${slug}`
            : slug === "quick-start"
              ? "/guide"
              : `/guide/${slug}`;
    return article ? `${path}#${article}` : path;
}
