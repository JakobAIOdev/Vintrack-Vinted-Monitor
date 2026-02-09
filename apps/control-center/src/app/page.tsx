import { db } from "@/lib/db";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const monitors = await db.monitors.findMany({
    orderBy: { id: "desc" },
    include: {
      _count: { select: { items: true } }
    }
  });

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <div>
           <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
           <p className="text-muted-foreground">Deine aktiven Suchaufträge</p>
        </div>
        <Link href="/monitors/new">
           <Button>+ Neuer Monitor</Button>
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {monitors.map((m) => (
          <Link key={m.id} href={`/monitors/${m.id}`}>
            <Card className="hover:shadow-lg transition-all cursor-pointer border-l-4 border-l-blue-500 h-full">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                  Monitor #{m.id}
                </CardTitle>
                <Badge variant={m.status === 'active' ? 'default' : 'destructive'}>
                  {m.status || 'unknown'}
                </Badge>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold mb-1 truncate" title={m.query}>{m.query}</div>
                
                <div className="text-xs text-muted-foreground mb-4 h-5">
                   {m.price_max ? `Max: ${m.price_max}€` : ''} 
                   {m.price_max && m.size_id ? ' • ' : ''}
                   {m.size_id ? `Size: ${m.size_id}` : ''}
                </div>

                <div className="flex justify-between items-center text-sm pt-4 border-t mt-2">
                   <span className="bg-slate-100 px-2 py-1 rounded text-slate-600 font-mono text-xs">
                      📦 {m._count.items} Items
                   </span>
                   <span className="text-gray-400 text-xs">
                      {m.created_at ? new Date(m.created_at).toLocaleDateString() : '-'}
                   </span>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}

        {monitors.length === 0 && (
            <div className="col-span-full text-center py-20 bg-slate-50 border border-dashed rounded-lg">
                <h3 className="text-lg font-medium">Noch keine Monitore</h3>
                <p className="text-muted-foreground mb-4">Erstelle deinen ersten Suchauftrag.</p>
                <Link href="/monitors/new"><Button>Jetzt starten</Button></Link>
            </div>
        )}
      </div>
    </div>
  );
}
