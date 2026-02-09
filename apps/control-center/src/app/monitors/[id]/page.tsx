import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { LiveFeed } from "@/components/monitors/live-feed";
import { Button } from "@/components/ui/button";
import { toggleMonitorStatus, deleteMonitor } from "@/actions/monitor";
import { ArrowLeft, PauseCircle, PlayCircle, Trash2 } from "lucide-react";
import Link from "next/link";

export default async function MonitorPage({ 
  params 
}: { 
  params: Promise<{ id: string }> 
}) {
  const resolvedParams = await params;
  const monitorId = parseInt(resolvedParams.id);

  if (isNaN(monitorId)) return notFound();

  const monitor = await db.monitors.findUnique({
    where: { id: monitorId },
  });

  if (!monitor) return notFound();

  const toggleAction = toggleMonitorStatus.bind(null, monitor.id, monitor.status || 'active');
  const deleteAction = deleteMonitor.bind(null, monitor.id);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
         <div className="flex items-center gap-4">
            <Link href="/">
                <Button variant="ghost" size="icon"><ArrowLeft /></Button>
            </Link>
            <div>
                <h1 className="text-2xl font-bold">{monitor.query}</h1>
                <div className="flex gap-2 text-sm text-muted-foreground">
                    <span>ID: {monitor.id}</span>
                    <span>•</span>
                    <span className={monitor.status === 'active' ? 'text-green-600' : 'text-red-600 font-bold'}>
                        {monitor.status?.toUpperCase()}
                    </span>
                </div>
            </div>
         </div>

         <div className="flex gap-2">
            <form action={toggleAction}>
                <Button variant={monitor.status === 'active' ? 'secondary' : 'default'}>
                    {monitor.status === 'active' ? <><PauseCircle className="mr-2 h-4 w-4"/> Stoppen</> : <><PlayCircle className="mr-2 h-4 w-4"/> Starten</>}
                </Button>
            </form>
            
            <form action={deleteAction}>
                 <Button variant="destructive" size="icon"><Trash2 className="h-4 w-4"/></Button>
            </form>
         </div>
      </div>

      <LiveFeed monitorId={monitor.id} />
    </div>
  );
}
