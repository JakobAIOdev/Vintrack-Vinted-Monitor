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
  { label: "S", id: "207" },
  { label: "M", id: "208" },
  { label: "L", id: "209" },
  { label: "XL", id: "210" },
];

export default function NewMonitorPage() {
  const [selectedSizes, setSelectedSizes] = useState<string[]>([]);

  const toggleSize = (id: string) => {
    setSelectedSizes(prev => 
      prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]
    );
  };

  return (
    <div className="max-w-2xl mx-auto py-10 space-y-6">
      
      <div className="flex items-center justify-between">
        <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">Create Monitor</h1>
            <p className="text-muted-foreground text-sm">Configure a new scraper task.</p>
        </div>
        <Link href="/dashboard">
            <Button variant="outline" size="sm" className="gap-2">
                <ArrowLeft className="w-4 h-4" /> Cancel
            </Button>
        </Link>
      </div>

      <Card>
        <CardContent className="p-6">
          <form action={createMonitor} className="space-y-8">
            
            <div className="space-y-2">
               <Label htmlFor="query">Search Query</Label>
               <Input 
                 name="query" 
                 id="query" 
                 placeholder="e.g. Nike Dunk Low Grey" 
                 required 
                 className="max-w-md"
               />
               <p className="text-[13px] text-muted-foreground">This exact text will be searched on Vinted.</p>
            </div>

            <div className="grid grid-cols-2 gap-6 max-w-md">
                <div className="space-y-2">
                    <Label htmlFor="price_min">Min Price</Label>
                    <div className="relative">
                        <span className="absolute left-3 top-2.5 text-muted-foreground text-sm">€</span>
                        <Input type="number" name="price_min" placeholder="0" className="pl-7" />
                    </div>
                </div>
                <div className="space-y-2">
                    <Label htmlFor="price_max">Max Price</Label>
                    <div className="relative">
                        <span className="absolute left-3 top-2.5 text-muted-foreground text-sm">€</span>
                        <Input type="number" name="price_max" placeholder="Any" className="pl-7" />
                    </div>
                </div>
            </div>

            <div className="space-y-3">
                <Label>Size Filter</Label>
                <div className="flex flex-wrap gap-2">
                    {SIZES.map((size) => {
                        const isSelected = selectedSizes.includes(size.id);
                        return (
                            <button
                                key={size.id}
                                type="button"
                                onClick={() => toggleSize(size.id)}
                                className={cn(
                                    "h-9 px-4 rounded-md text-sm font-medium border transition-colors flex items-center gap-2",
                                    isSelected 
                                        ? "bg-primary text-primary-foreground border-primary" 
                                        : "bg-background hover:bg-muted border-input text-foreground"
                                )}
                            >
                                {size.label}
                                {isSelected && <Check className="w-3 h-3" />}
                            </button>
                        );
                    })}
                </div>
                
                <div className="pt-2">
                    <Input 
                        name="size_id" 
                        id="size_id" 
                        value={selectedSizes.join(",")} 
                        onChange={(e) => setSelectedSizes(e.target.value.split(","))}
                        placeholder="Or enter custom IDs (comma separated)" 
                        className="max-w-md text-sm font-mono placeholder:font-sans"
                    />
                </div>
            </div>

            <div className="space-y-2 pt-2">
                <Label htmlFor="discord_webhook">Discord Webhook <span className="text-muted-foreground font-normal ml-1">(Optional)</span></Label>
                <Input 
                    name="discord_webhook" 
                    id="discord_webhook" 
                    placeholder="https://discord.com/api/webhooks/..." 
                />
            </div>

            <div className="pt-4 flex justify-end border-t mt-8">
               <Button type="submit" className="min-w-[140px]">
                   <Plus className="w-4 h-4 mr-2" /> Create Monitor
               </Button>
            </div>

          </form>
        </CardContent>
      </Card>
    </div>
  );
}
