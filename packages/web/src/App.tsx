import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { SseProvider } from "./api/events.tsx";
import { RegistryProvider } from "./api/registry.tsx";
import { Layout } from "./components/Layout.tsx";
import { ConfirmProvider } from "./components/Overlay.tsx";
import { Loading, Empty } from "./components/States.tsx";
import { ToastProvider } from "./components/Toast.tsx";

const Home = lazy(() => import("./pages/Home.tsx"));
const Council = lazy(() => import("./pages/Council.tsx"));
const Decree = lazy(() => import("./pages/Decree.tsx"));
const EdictList = lazy(() => import("./pages/EdictList.tsx"));
const EdictTrace = lazy(() => import("./pages/edict/EdictTrace.tsx"));
const Court = lazy(() => import("./pages/Court.tsx"));
const Dept = lazy(() => import("./pages/Dept.tsx"));
const OfficialPage = lazy(() => import("./pages/Official.tsx"));
const Schedules = lazy(() => import("./pages/Schedules.tsx"));
const Assets = lazy(() => import("./pages/Assets.tsx"));
const Ledger = lazy(() => import("./pages/Ledger.tsx"));
const Libu = lazy(() => import("./pages/Libu.tsx"));
const Exams = lazy(() => import("./pages/Exams.tsx"));
const Censor = lazy(() => import("./pages/Censor.tsx"));
const Feed = lazy(() => import("./pages/Feed.tsx"));
const Settings = lazy(() => import("./pages/Settings.tsx"));

export function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <SseProvider>
          <RegistryProvider>
            <BrowserRouter>
              <Suspense fallback={<Loading />}>
                <Routes>
                  <Route element={<Layout />}>
                    <Route index element={<Home />} />
                    <Route path="council" element={<Council />} />
                    <Route path="decree" element={<Decree />} />
                    <Route path="edicts" element={<EdictList />} />
                    <Route path="edicts/:id" element={<EdictTrace />} />
                    <Route path="court" element={<Court />} />
                    <Route path="depts/:id" element={<Dept />} />
                    <Route path="officials/:post" element={<OfficialPage />} />
                    <Route path="schedules" element={<Schedules />} />
                    <Route path="assets" element={<Assets />} />
                    <Route path="ledger" element={<Ledger />} />
                    <Route path="libu" element={<Libu />} />
                    <Route path="exams" element={<Exams />} />
                    <Route path="censor" element={<Censor />} />
                    <Route path="feed" element={<Feed />} />
                    <Route path="settings" element={<Settings />} />
                    <Route path="*" element={<div className="page"><Empty text="此处无路可走" seal="迷" /></div>} />
                  </Route>
                </Routes>
              </Suspense>
            </BrowserRouter>
          </RegistryProvider>
        </SseProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
