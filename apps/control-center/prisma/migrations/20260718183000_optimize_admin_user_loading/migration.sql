CREATE INDEX "User_name_idx" ON "User"("name");

CREATE INDEX "monitors_userId_idx" ON "monitors"("userId");

CREATE INDEX "monitors_status_userId_idx" ON "monitors"("status", "userId");

CREATE INDEX "proxy_groups_userId_idx" ON "proxy_groups"("userId");
