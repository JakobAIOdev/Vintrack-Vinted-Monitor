import { notFound } from "next/navigation";
import { getGuideTopic } from "@/lib/guides";
import { GuideContent, GuideHeader } from "@/components/guides/guide-content";

export default async function GuideTopicPage({
    params,
}: {
    params: Promise<{ topic: string }>;
}) {
    const topic = getGuideTopic((await params).topic);
    if (!topic) notFound();
    return (
        <div className="mx-auto max-w-6xl space-y-7">
            <GuideHeader placement="app" topic={topic} />
            <GuideContent placement="app" topic={topic} />
        </div>
    );
}
