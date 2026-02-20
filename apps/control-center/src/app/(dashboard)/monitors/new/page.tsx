"use client";

import { createMonitor } from "@/actions/monitor";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CategoryPicker } from "@/components/monitors/category-picker";
import { BrandPicker } from "@/components/monitors/brand-picker";
import { SizePicker } from "@/components/monitors/size-picker";
import { ArrowLeft, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

export default function NewMonitorPage() {
  const [selectedSizes, setSelectedSizes] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedBrands, setSelectedBrands] = useState<string[]>([]);

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

            <div className="space-y-2">
              <Label className="text-[13px]">
                Category Filter{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </Label>
              <CategoryPicker
                selected={selectedCategories}
                onChange={setSelectedCategories}
              />
              <input
                type="hidden"
                name="catalog_ids"
                value={selectedCategories.join(",")}
              />
              <p className="text-[12px] text-muted-foreground">
                Limit results to specific Vinted categories.
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

            <div className="space-y-2">
              <Label className="text-[13px]">
                Brand Filter{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </Label>
              <BrandPicker
                selected={selectedBrands}
                onChange={setSelectedBrands}
              />
              <input
                type="hidden"
                name="brand_ids"
                value={selectedBrands.join(",")}
              />
              <p className="text-[12px] text-muted-foreground">
                Limit results to specific brands.
              </p>
            </div>

            <div className="space-y-2.5">
              <Label className="text-[13px]">
                Size Filter{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </Label>
              <SizePicker
                selected={selectedSizes}
                onChange={setSelectedSizes}
              />
              <input
                type="hidden"
                name="size_id"
                value={selectedSizes.join(",")}
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
