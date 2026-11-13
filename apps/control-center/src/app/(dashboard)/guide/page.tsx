import { GuideContent, GuideHeader } from "@/components/guides/guide-content";
import { GUIDE_TOPICS } from "@/lib/guides";

export default function GuidePage() {
    const topic = GUIDE_TOPICS[0];
    return (
        <div className="mx-auto max-w-6xl space-y-7">
            <GuideHeader placement="app" topic={topic} />
            <GuideContent placement="app" topic={topic} />
        </div>
    );
}
