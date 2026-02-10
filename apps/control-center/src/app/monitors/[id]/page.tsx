import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { LiveFeed } from "@/components/monitors/live-feed";
import { Button } from "@/components/ui/button";
import { toggleMonitorStatus, deleteMonitor } from "@/actions/monitor";
import { ArrowLeft, PauseCircle, PlayCircle, Trash2, Tag, Search } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";

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
    <div className="max-w-7xl mx-auto space-y-8 p-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b pb-6">
         <div className="flex items-center gap-4">
            <Link href="/dashboard">
                <Button variant="outline" size="icon" className="h-10 w-10"><ArrowLeft className="h-5 w-5" /></Button>
            </Link>
            
            <div>
                <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
                    {monitor.query}
                    <Badge variant={monitor.status === 'active' ? 'default' : 'destructive'} className="ml-2">
                        {monitor.status?.toUpperCase() || 'UNKNOWN'}
                    </Badge>
                </h1>
                
                <div className="flex items-center gap-4 text-sm text-muted-foreground mt-1">
                    <span className="flex items-center gap-1"><Search className="h-3 w-3" /> Monitor ID: {monitor.id}</span>
                    <span>•</span>
                    {monitor.price_max && (
                        <span className="flex items-center gap-1"><Tag className="h-3 w-3" /> Max Price: {monitor.price_max}€</span>
                    )}
                </div>
            </div>
         </div>

         <div className="flex items-center gap-3">
            <form action={toggleAction}>
                <Button 
                    variant={monitor.status === 'active' ? 'outline' : 'default'} 
                    className={monitor.status === 'active' ? "text-amber-600 hover:text-amber-700 hover:bg-amber-50 border-amber-200" : "bg-green-600 hover:bg-green-500"}
                >
                    {monitor.status === 'active' ? <><PauseCircle className="mr-2 h-4 w-4"/> Pause Monitor</> : <><PlayCircle className="mr-2 h-4 w-4"/> Start Monitor</>}
                </Button>
            </form>
            
            <form action={deleteAction}>
                 <Button variant="destructive" size="icon" title="Delete Monitor"><Trash2 className="h-4 w-4"/></Button>
            </form>
         </div>
      </div>

      <div className="space-y-4">
          <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">Latest Results</h2>
              <div className="text-xs text-muted-foreground">Auto-refreshing every 2s</div>
          </div>
          <LiveFeed monitorId={monitor.id} />
      </div>
    </div>
  );
}
