"use client";

import {
  createProxyGroup,
  deleteProxyGroup,
  updateProxyGroup,
} from "@/actions/proxy-groups";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ChevronDown,
  ChevronUp,
  Globe,
  Plus,
  Server,
  Shield,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export type ProxyGroup = {
  id: number;
  name: string;
  proxies: string;
  monitorCount: number;
  created_at: string;
};

export function ProxiesClient({
  initialGroups,
  userRole,
}: {
  initialGroups: ProxyGroup[];
  userRole: string;
}) {
  const [groups, setGroups] = useState<ProxyGroup[]>(initialGroups);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editProxies, setEditProxies] = useState("");

  const handleCreate = async (formData: FormData) => {
    try {
      await createProxyGroup(formData);
      setIsCreateOpen(false);
      toast.success("Proxy group created");
      // Refresh page to get updated data
      window.location.reload();
    } catch (e: any) {
      toast.error(e.message || "Failed to create proxy group");
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteProxyGroup(id);
      setGroups((prev) => prev.filter((g) => g.id !== id));
      toast.success("Proxy group deleted");
    } catch (e: any) {
      toast.error(e.message || "Failed to delete proxy group");
    }
  };

  const handleUpdate = async (id: number) => {
    try {
      const formData = new FormData();
      formData.set("name", editName);
      formData.set("proxies", editProxies);
      await updateProxyGroup(id, formData);
      setGroups((prev) =>
        prev.map((g) =>
          g.id === id ? { ...g, name: editName, proxies: editProxies } : g,
        ),
      );
      setEditingId(null);
      toast.success("Proxy group updated");
    } catch (e: any) {
      toast.error(e.message || "Failed to update proxy group");
    }
  };

  const getProxyCount = (proxies: string) =>
    proxies.split("\n").filter((l) => l.trim().length > 0).length;

  return (
    <div className="space-y-6 mx-auto max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Proxy Groups</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage your proxy lists for monitors.
          </p>
        </div>
        <Button
          onClick={() => setIsCreateOpen(true)}
          size="sm"
          className="gap-1.5"
        >
          <Plus className="w-4 h-4" /> New Group
        </Button>
      </div>

      {userRole === "premium" && (
        <Card className="border-amber-200/60 bg-amber-50/50">
          <CardContent className="p-4 flex items-center gap-3">
            <Shield className="w-5 h-5 text-amber-600 shrink-0" />
            <div>
              <p className="text-[13px] font-medium text-amber-900">
                Premium Account
              </p>
              <p className="text-[12px] text-amber-700">
                You can use server proxies when creating monitors, or use your
                own proxy groups.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {groups.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="p-12 text-center">
            <Globe className="w-10 h-10 text-slate-300 mx-auto mb-3" />
            <p className="text-[15px] font-medium text-slate-600">
              No proxy groups yet
            </p>
            <p className="text-[13px] text-muted-foreground mt-1">
              Create a proxy group to start monitoring. Each monitor needs a
              proxy group to scrape Vinted.
            </p>
            <Button
              onClick={() => setIsCreateOpen(true)}
              size="sm"
              className="mt-4 gap-1.5"
              variant="outline"
            >
              <Plus className="w-4 h-4" /> Create your first group
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <Card key={group.id} className="border-slate-200/60">
              <CardContent className="p-0">
                <div
                  className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-slate-50/50 transition-colors"
                  onClick={() =>
                    setExpandedId(expandedId === group.id ? null : group.id)
                  }
                >
                  <div className="flex items-center gap-3">
                    <Server className="w-4 h-4 text-slate-400" />
                    <div>
                      <p className="text-[14px] font-medium text-slate-800">
                        {group.name}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[12px] text-muted-foreground">
                          {getProxyCount(group.proxies)} proxies
                        </span>
                        <span className="text-slate-200">·</span>
                        <span className="text-[12px] text-muted-foreground">
                          {group.monitorCount} monitor
                          {group.monitorCount !== 1 ? "s" : ""}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-slate-400 hover:text-red-500"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(group.id);
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                    {expandedId === group.id ? (
                      <ChevronUp className="w-4 h-4 text-slate-400" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-400" />
                    )}
                  </div>
                </div>

                {expandedId === group.id && (
                  <div className="border-t border-slate-100 px-5 py-4 space-y-3">
                    {editingId === group.id ? (
                      <>
                        <div className="space-y-2">
                          <Label className="text-[12px]">Name</Label>
                          <Input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="text-[13px]"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-[12px]">
                            Proxies (one per line)
                          </Label>
                          <textarea
                            value={editProxies}
                            onChange={(e) => setEditProxies(e.target.value)}
                            rows={6}
                            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-[12px] font-mono text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-1"
                            placeholder="http://user:pass@host:port"
                          />
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => handleUpdate(group.id)}
                          >
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setEditingId(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="bg-slate-50 rounded-lg p-3">
                          <pre className="text-[11px] font-mono text-slate-600 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                            {group.proxies
                              .split("\n")
                              .filter((l) => l.trim())
                              .map((line) => {
                                // Mask proxy credentials
                                try {
                                  const url = new URL(line.trim());
                                  if (url.username) {
                                    return `${url.protocol}//${url.username}:****@${url.host}`;
                                  }
                                } catch {}
                                return line.replace(/:[^:@]+@/, ":****@");
                              })
                              .join("\n")}
                          </pre>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditingId(group.id);
                            setEditName(group.name);
                            setEditProxies(group.proxies);
                          }}
                        >
                          Edit
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Proxy Group</DialogTitle>
            <DialogDescription>
              Add a group of proxies to use with your monitors.
            </DialogDescription>
          </DialogHeader>
          <form action={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name" className="text-[13px]">
                Group Name
              </Label>
              <Input
                name="name"
                id="name"
                placeholder="e.g. Residential EU"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="proxies" className="text-[13px]">
                Proxies
              </Label>
              <textarea
                name="proxies"
                id="proxies"
                rows={8}
                required
                className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-[13px] font-mono text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-1"
                placeholder={
                  "http://user:pass@host:port\nhttp://user:pass@host:port\n\nSupported formats:\nhttp://user:pass@host:port\nsocks5://user:pass@host:port\nhost:port:user:pass"
                }
              />
              <p className="text-[12px] text-muted-foreground">
                One proxy per line. Supports HTTP, HTTPS, and SOCKS5.
              </p>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit">Create Group</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
