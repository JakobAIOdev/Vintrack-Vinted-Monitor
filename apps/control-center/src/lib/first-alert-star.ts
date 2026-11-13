export const FIRST_ALERT_STAR_VERSION = "first-alert-v1";
export const FIRST_ALERT_STAR_TYPE = "first_alert_star";

export type FirstAlertStarPrompt = {
    repositoryUrl: string;
    currentLimit: number;
    starLimit: number;
};

export type FirstAlertStarResult = {
    prompt: FirstAlertStarPrompt | null;
    retry: boolean;
};
