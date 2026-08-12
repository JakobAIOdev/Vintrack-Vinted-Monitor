import "server-only";

import { db } from "@/lib/db";
import {
    DEFAULT_MEMBER_ANNOUNCEMENT,
    MEMBER_ANNOUNCEMENT_SETTING_KEY,
    parseMemberAnnouncement,
    type MemberAnnouncement,
} from "@/lib/member-announcement";

export async function getMemberAnnouncement(): Promise<MemberAnnouncement> {
    try {
        const setting = await db.app_settings.findUnique({
            where: { key: MEMBER_ANNOUNCEMENT_SETTING_KEY },
            select: { value: true },
        });
        return parseMemberAnnouncement(setting?.value);
    } catch (error) {
        console.error(
            "[announcement] failed to load member announcement",
            error,
        );
        return DEFAULT_MEMBER_ANNOUNCEMENT;
    }
}
