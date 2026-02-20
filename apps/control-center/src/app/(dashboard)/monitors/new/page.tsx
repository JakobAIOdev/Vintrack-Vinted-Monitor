"use client";

import { createMonitor } from "@/actions/monitor";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Check, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { cn } from "@/lib/utils";

const SIZES = [
  { label: "XS", id: "206" },
  { label: "S", id: "207" },
  { label: "M", id: "208" },
  { label: "L", id: "209" },
  { label: "XL", id: "210" },
  { label: "XXL", id: "211" },
];

export default function NewMonitorPage() {
  const [selectedSizes, setSelectedSizes] = useState<string[]>([]);

  const toggleSize = (id: string) => {
    setSelectedSizes((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  };

  return (
    <div className="max-w-xl mx-auto py-8 px-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard">
          <Button variant="outline" size="icon" className="h-8 w-8">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Create Monitor</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Set up a new Vinted scraper.
          </p>
        </div>
      </div>

      <Card className="border-slate-200/60">
        <CardContent className="p-6">
          <form action={createMonitor} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="query" className="text-[13px]">
                Search Query
              </Label>
              <Input
                name="query"
                id="query"
                placeholder="e.g. Nike Dunk Low Grey"
                required
              />
              <p className="text-[12px] text-muted-foreground">
                This text will be searched on Vinted exactly as entered.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="price_min" className="text-[13px]">
                  Min Price
                </Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                    €
                  </span>
                  <Input
                    type="number"
                    name="price_min"
                    placeholder="0"
                    className="pl-7"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="price_max" className="text-[13px]">
                  Max Price
                </Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                    €
                  </span>
                  <Input
                    type="number"
                    name="price_max"
                    placeholder="Any"
                    className="pl-7"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2.5">
              <Label className="text-[13px]">Size Filter</Label>
              <div className="flex flex-wrap gap-2">
                {SIZES.map((size) => {
                  const isSelected = selectedSizes.includes(size.id);
                  return (
                    <button
                      key={size.id}
                      type="button"
                      onClick={() => toggleSize(size.id)}
                      className={cn(
                        "h-8 px-3.5 rounded-lg text-[13px] font-medium border transition-colors flex items-center gap-1.5",
                        isSelected
                          ? "bg-slate-900 text-white border-slate-900"
                          : "bg-white hover:bg-slate-50 border-slate-200 text-slate-600"
                      )}
                    >
                      {size.label}
                      {isSelected && <Check className="w-3 h-3" />}
                    </button>
                  );
                })}
              </div>

              <Input
                name="size_id"
                id="size_id"
                value={selectedSizes.join(",")}
                onChange={(e) => setSelectedSizes(e.target.value.split(","))}
                placeholder="Or enter custom size IDs (comma separated)"
                className="text-[13px] font-mono placeholder:font-sans"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="discord_webhook" className="text-[13px]">
                Discord Webhook{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </Label>
              <Input
                name="discord_webhook"
                id="discord_webhook"
                placeholder="https://discord.com/api/webhooks/..."
              />
            </div>

            <div className="pt-2">
              <Button type="submit" className="w-full gap-1.5">
                <Plus className="w-4 h-4" /> Create Monitor
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
