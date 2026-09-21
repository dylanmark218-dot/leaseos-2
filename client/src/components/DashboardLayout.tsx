import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { startLogin } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import {
  Activity,
  BriefcaseBusiness,
  Camera,
  ChevronRight,
  CircleHelp,
  LayoutDashboard,
  LogOut,
  Map,
  PanelLeft,
  ShieldCheck,
  Truck,
  MapPinned,
  FileCheck2,
  CloudOff,
  DollarSign,
  Navigation,
  Factory,
  Timer,
  GraduationCap,
} from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from "./DashboardLayoutSkeleton";
import { Button } from "./ui/button";

const menuItems = [
  { icon: LayoutDashboard, label: "Overview", path: "/" },
  { icon: Map, label: "Field map", path: "/map" },
  { icon: BriefcaseBusiness, label: "Jobs", path: "/jobs", badge: "12" },
  { icon: Camera, label: "Evidence", path: "/evidence", badge: "3" },
  { icon: ShieldCheck, label: "Safety & compliance", path: "/safety" },
  { icon: Truck, label: "Fleet & compliance", path: "/fleet" },
  { icon: MapPinned, label: "Locations & passports", path: "/locations" },
  { icon: FileCheck2, label: "Compliance engine", path: "/compliance-engine" },
  { icon: CloudOff, label: "Offline vault", path: "/offline-vault" },
  { icon: DollarSign, label: "Billing & unit safety", path: "/billing-safety" },
  { icon: Navigation, label: "Route safety", path: "/route-safety" },
  { icon: Factory, label: "Disposal directory", path: "/disposal-directory" },
  { icon: Timer, label: "Trip operations", path: "/trip-operations" },
  { icon: GraduationCap, label: "Training Academy", path: "/training-academy" },
];

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 254;
const MIN_WIDTH = 220;
const MAX_WIDTH = 400;

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const { loading, user } = useAuth();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  if (loading) return <DashboardLayoutSkeleton />;

  if (!user) {
    return (
      <div className="min-h-screen bg-[#f6f8fb] text-[#172033] flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-[28px] border border-[#dfe5ee] bg-white p-10 text-center shadow-[0_24px_80px_rgba(31,52,85,0.12)]">
          <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#132a4a] text-white shadow-lg shadow-[#132a4a]/20">
            <Activity className="h-7 w-7" />
          </div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.22em] text-[#6e7f96]">
            LeaseOS / FieldRoute
          </p>
          <h1 className="text-3xl font-semibold tracking-[-0.04em]">
            Sign in to command center
          </h1>
          <p className="mt-3 text-sm leading-6 text-[#6e7f96]">
            Coordinate field work, evidence, routes, and compliance from one
            operating picture.
          </p>
          <Button
            onClick={() => startLogin()}
            className="mt-8 h-11 w-full rounded-xl bg-[#ff6b42] font-semibold text-white shadow-lg shadow-[#ff6b42]/20 hover:bg-[#ed5c35]"
          >
            Sign in
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>
        {children}
      </DashboardLayoutContent>
    </SidebarProvider>
  );
}

type DashboardLayoutContentProps = {
  children: React.ReactNode;
  setSidebarWidth: (width: number) => void;
};

function DashboardLayoutContent({
  children,
  setSidebarWidth,
}: DashboardLayoutContentProps) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const activeMenuItem =
    menuItems.find(item => item.path === location) ?? menuItems[0];
  const isMobile = useIsMobile();

  useEffect(() => {
    if (isCollapsed) setIsResizing(false);
  }, [isCollapsed]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!isResizing) return;
      const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      const newWidth = event.clientX - sidebarLeft;
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH)
        setSidebarWidth(newWidth);
    };
    const handleMouseUp = () => setIsResizing(false);
    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  return (
    <>
      <div className="relative" ref={sidebarRef}>
        <Sidebar
          collapsible="icon"
          className="border-r border-[#e0e6ee] bg-[#10243f] text-white"
          disableTransition={isResizing}
        >
          <SidebarHeader className="h-[84px] justify-center border-b border-white/10 px-4">
            <div className="flex w-full items-center gap-3">
              <button
                onClick={toggleSidebar}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/10 text-white/70 transition hover:bg-white/15 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#ff8c67]"
                aria-label="Toggle navigation"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
              {!isCollapsed && (
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold tracking-[-0.02em] text-white">
                    LeaseOS
                  </p>
                  <p className="truncate text-[10px] font-medium uppercase tracking-[0.22em] text-[#9fb0c7]">
                    FieldRoute command
                  </p>
                </div>
              )}
            </div>
          </SidebarHeader>

          <SidebarContent className="gap-0 px-3 py-6">
            {!isCollapsed && (
              <p className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7186a3]">
                Workspace
              </p>
            )}
            <SidebarMenu className="gap-1">
              {menuItems.map(item => {
                const isActive = location === item.path;
                return (
                  <SidebarMenuItem key={item.path}>
                    <SidebarMenuButton
                      isActive={isActive}
                      onClick={() => setLocation(item.path)}
                      tooltip={item.label}
                      className={`h-11 rounded-xl font-medium transition ${isActive ? "bg-[#ff6b42] text-white hover:bg-[#ff6b42] hover:text-white" : "text-[#b6c4d7] hover:bg-white/10 hover:text-white"}`}
                    >
                      <item.icon className="h-[18px] w-[18px]" />
                      <span>{item.label}</span>
                      {!isCollapsed && item.badge && (
                        <span
                          className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold ${isActive ? "bg-white/20 text-white" : "bg-white/10 text-[#b6c4d7]"}`}
                        >
                          {item.badge}
                        </span>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>

            {!isCollapsed && (
              <div className="mt-8 rounded-2xl border border-white/10 bg-white/[0.06] p-4">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-[#d5f4eb] text-[#147d69]">
                    <Activity className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-white">
                      Network healthy
                    </p>
                    <p className="mt-1 text-[11px] leading-4 text-[#9fb0c7]">
                      Offline maps synced 92%
                    </p>
                  </div>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full w-[92%] rounded-full bg-[#57d0a5]" />
                </div>
              </div>
            )}
          </SidebarContent>

          <SidebarFooter className="border-t border-white/10 p-3">
            <button
              className="mb-2 flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-[#a9bad0] transition hover:bg-white/10 hover:text-white"
              onClick={() => setLocation("/safety")}
            >
              <CircleHelp className="h-4 w-4 shrink-0" />
              {!isCollapsed && (
                <span className="text-xs font-medium">Help & protocols</span>
              )}
              {!isCollapsed && <ChevronRight className="ml-auto h-3.5 w-3.5" />}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#ff8c67] group-data-[collapsible=icon]:justify-center">
                  <Avatar className="h-9 w-9 shrink-0 border border-white/20 bg-[#243e60]">
                    <AvatarFallback className="bg-[#243e60] text-xs font-semibold text-white">
                      {user?.name?.charAt(0).toUpperCase() || "O"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                    <p className="truncate text-sm font-medium text-white">
                      {user?.name || "Operator"}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-[#9fb0c7]">
                      {user?.email || "Field operations"}
                    </p>
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  onClick={logout}
                  className="cursor-pointer text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarFooter>
        </Sidebar>
        <div
          className={`absolute right-0 top-0 h-full w-1 cursor-col-resize transition-colors hover:bg-[#ff6b42]/30 ${isCollapsed ? "hidden" : ""}`}
          onMouseDown={() => !isCollapsed && setIsResizing(true)}
          style={{ zIndex: 50 }}
        />
      </div>

      <SidebarInset className="bg-[#f6f8fb]">
        {isMobile && (
          <div className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-[#e0e6ee] bg-[#f6f8fb]/95 px-4 backdrop-blur">
            <SidebarTrigger className="h-9 w-9 rounded-lg bg-white" />
            <span className="text-sm font-semibold text-[#172033]">
              {activeMenuItem?.label}
            </span>
          </div>
        )}
        <main className="min-h-screen">{children}</main>
      </SidebarInset>
    </>
  );
}
