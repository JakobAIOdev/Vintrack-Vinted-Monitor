"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Activity, PauseCircle, PlayCircle, Plus, StopCircle, Webhook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { stopAllMonitors, toggleMonitor, updateMonitorWebhook, toggleWebhookStatus } from "@/actions/dashboard-actions";

export type Monitor = {
    id: number;
    query: string;
    status: string;
    price_max: number | null; 
    discord_webhook: string | null;
    webhook_active: boolean;
    _count: { items: number };
    created_at: string;
};

export function DashboardClient({ initialMonitors, userName }: { initialMonitors: Monitor[], userName: string }) {
    const [selectedMonitor, setSelectedMonitor] = useState<Monitor | null>(null);
    const [webhookInput, setWebhookInput] = useState("");
    const [isWebhookOpen, setIsWebhookOpen] = useState(false);
    const [isWebhookActive, setIsWebhookActive] = useState(true);
    const [monitors, setMonitors] = useState<Monitor[]>(initialMonitors);

    const openWebhookDialog = (monitor: Monitor) => {
        setSelectedMonitor(monitor);
        setWebhookInput(monitor.discord_webhook || "");
        setIsWebhookActive(monitor.webhook_active);
        setIsWebhookOpen(true);
    };

    const sortedMonitors = useMemo(() => {
        return [...monitors].sort((a, b) => {
            if (a.status === 'active' && b.status !== 'active') return -1;
            if (a.status !== 'active' && b.status === 'active') return 1;
            
            return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });
    }, [monitors]);

    const handleStopAll = async () => {
        setMonitors(prev => prev.map(m => ({ ...m, status: 'paused' })));

        toast.promise(stopAllMonitors(), {
            loading: 'Stopping all monitors...',
            success: 'All monitors stopped!',
            error: 'Failed to stop monitors',
        });
    };

    const handleToggle = async (id: number, currentStatus: string) => {
        const newStatus = currentStatus === 'active' ? 'paused' : 'active';
        const actionText = newStatus === 'active' ? 'Resumed' : 'Paused';

        setMonitors(prev => prev.map(m => 
            m.id === id ? { ...m, status: newStatus } : m
        ));

        toast.promise(toggleMonitor(id, currentStatus), {
            loading: 'Switching state...',
            success: `Monitor ${actionText}!`,
            error: (err) => {
                setMonitors(prev => prev.map(m => 
                    m.id === id ? { ...m, status: currentStatus } : m
                ));
                return "Failed to update monitor";
            }
        });
    };

    const handleSaveWebhook = async () => {
        if (!selectedMonitor) return;

        setMonitors(prev => prev.map(m => 
            m.id === selectedMonitor.id ? { ...m, discord_webhook: webhookInput } : m
        ));
        
        toast.promise(updateMonitorWebhook(selectedMonitor.id, webhookInput), {
            loading: 'Saving webhook...',
            success: () => {
                setIsWebhookOpen(false);
                return "Discord Webhook saved!";
            },
            error: "Failed to save webhook"
        });
    };

    const activeCount = monitors.filter(m => m.status === 'active').length;

    return (
        <div className="p-8 space-y-6 max-w-[1600px] mx-auto">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 pb-6 border-b">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
                    <p className="text-muted-foreground mt-1">
                        Welcome back, <span className="font-medium text-foreground">{userName}</span>.
                    </p>
                </div>

                <div className="flex items-center gap-3">
                    <div className="hidden md:flex items-center gap-2 mr-4 text-sm text-slate-500">
                        <Activity className="w-4 h-4 text-blue-600" />
                        <span>{activeCount} Active</span>
                    </div>

                    {activeCount > 0 && (
                        <Button variant="destructive" size="sm" onClick={handleStopAll} className="gap-2">
                            <StopCircle className="w-4 h-4" /> Stop All
                        </Button>
                    )}

                    <Link href="/monitors/new">
                        <Button size="sm" className="gap-2 bg-blue-600 hover:bg-blue-500">
                            <Plus className="w-4 h-4" /> New Monitor
                        </Button>
                    </Link>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {sortedMonitors.map((m) => (
                    <Card key={m.id} className={`relative group transition-all hover:shadow-lg border-l-4 ${m.status === 'active' ? 'border-l-green-500' : 'border-l-slate-300'}`}>
                        <CardHeader className="flex flex-row items-start justify-between pb-2">
                            <div className="w-full">
                                <div className="flex justify-between items-start w-full">
                                    <h3 className="font-bold text-lg leading-none truncate max-w-[180px]" title={m.query}>
                                        {m.query}
                                    </h3>
                                    <Button 
                                        variant="ghost" 
                                        size="icon" 
                                        className="h-6 w-6 text-slate-400 hover:text-indigo-500 -mt-1 -mr-2"
                                        onClick={() => openWebhookDialog(m)}
                                        title="Configure Discord Webhook"
                                    >
                                        <Webhook className={`w-4 h-4 ${(m.discord_webhook && m.webhook_active) ? 'text-indigo-500 fill-indigo-100' : m.discord_webhook ? 'text-slate-500' : ''}`} />
                                    </Button>
                                </div>
                                
                                <div className="flex gap-2 mt-2">
                                    {m.price_max && <Badge variant="secondary" className="text-[10px]">Max {m.price_max}€</Badge>}
                                    <Badge variant={m.status === 'active' ? 'default' : 'outline'} className="text-[10px]">
                                        {m.status === 'active' ? 'RUNNING' : 'PAUSED'}
                                    </Badge>
                                </div>
                            </div>
                        </CardHeader>
                        
                        <CardContent>
                            <div className="flex justify-between items-center border-t pt-4 mt-2">
                                <div className="text-sm text-slate-500 font-mono">
                                    <strong>{m._count.items}</strong> Items
                                </div>
                                
                                <div className="flex gap-2">
                                     <Button 
                                        variant="ghost" 
                                        size="sm" 
                                        onClick={() => handleToggle(m.id, m.status)}
                                        className={m.status === 'active' ? "text-amber-600 hover:text-amber-700 hover:bg-amber-50" : "text-green-600 hover:text-green-700 hover:bg-green-50"}
                                    >
                                        {m.status === 'active' ? <PauseCircle className="w-5 h-5" /> : <PlayCircle className="w-5 h-5" />}
                                    </Button>
                                    
                                    <Link href={`/monitors/${m.id}`}>
                                        <Button variant="outline" size="sm">View</Button>
                                    </Link>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            <Dialog open={isWebhookOpen} onOpenChange={setIsWebhookOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Discord Integration</DialogTitle>
                        <DialogDescription>
                            Notifications for <strong>{selectedMonitor?.query}</strong>
                        </DialogDescription>
                    </DialogHeader>
                    
                    <div className="grid gap-6 py-4">
                        <div className="grid gap-2">
                            <Label htmlFor="webhook">Webhook URL</Label>
                            <Input 
                                id="webhook" 
                                placeholder="https://discord.com/api/webhooks/..." 
                                value={webhookInput}
                                onChange={(e) => setWebhookInput(e.target.value)}
                            />
                        </div>

                        {(webhookInput.length > 0) && (
                            <div className="flex items-center justify-between space-x-2 border p-3 rounded-lg bg-slate-50">
                                <div className="flex flex-col space-y-1">
                                    <Label htmlFor="active-mode" className="font-medium cursor-pointer">Enable Notifications</Label>
                                    <span className="text-xs text-muted-foreground">
                                        Turn off to stop receiving messages without deleting the URL.
                                    </span>
                                </div>
                                <Switch 
                                    id="active-mode" 
                                    checked={isWebhookActive}
                                    onCheckedChange={async (checked) => {
                                         setIsWebhookActive(checked);
                                         if (selectedMonitor) {
                                            toast.promise(toggleWebhookStatus(selectedMonitor.id, !checked), {
                                                success: checked ? "Webhook activated" : "Webhook deactivated",
                                                error: "Failed to toggle"
                                            });
                                         }
                                    }}
                                />
                            </div>
                        )}
                    </div>
                    
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsWebhookOpen(false)}>Close</Button>
                        <Button onClick={handleSaveWebhook} className="bg-indigo-600 hover:bg-indigo-500">Save URL</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
