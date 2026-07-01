import React, { useState, useEffect, useRef } from "react";
import {
  Activity,
  Terminal as TerminalIcon,
  Play,
  Pause,
  RefreshCw,
  Search,
  CheckCircle,
  AlertTriangle,
  Database,
  FileText,
  Download,
  Trash2,
  Lock,
  Key,
  Layers,
  HelpCircle,
  ChevronRight,
  Globe,
  Upload,
  BookOpen,
  ArrowDown
} from "lucide-react";

// Types matching backend server structures
interface Coin {
  name: string;
  symbol: string;
  price: number;
  change_1h?: number;
  change_24h: number;
  change_7d?: number;
  market_cap: number;
  volume_24h: number;
  cmc_rank?: number;
  slug: string;
  url: string;
}

interface GeneratedMessage {
  name: string;
  symbol: string;
  url: string;
  message: string;
}

interface PostResult {
  name: string;
  symbol: string;
  url: string;
  status: "success" | "captcha" | "expired" | "failed" | "retry" | "skipped";
  message: string;
  timestamp: string;
}

interface LogEntry {
  timestamp: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
}

const resolveUrl = (url: string): string => {
  const base = (import.meta as any).env?.BASE_URL || "/";
  if (url.startsWith("/")) {
    const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
    return `${normalizedBase}${url}`;
  }
  return url;
};

export default function App() {
  // Application State
  const [status, setStatus] = useState<string>("Idle");
  const [runMode, setRunMode] = useState<string>("Real Browser");
  const [totalCoins, setTotalCoins] = useState<number>(0);
  const [generatedCount, setGeneratedCount] = useState<number>(0);
  const [postedCount, setPostedCount] = useState<number>(0);
  const [failedCount, setFailedCount] = useState<number>(0);
  const [results, setResults] = useState<PostResult[]>([]);
  const [progressIndex, setProgressIndex] = useState<number>(0);
  const [currentCoin, setCurrentCoin] = useState<string>("N/A");
  const [sessionStatus, setSessionStatus] = useState<string>("Not Checked");
  const [apiStatus, setApiStatus] = useState({ openai: false, cmc: false });

  // Browser Session Upload State
  const [sessionJson, setSessionJson] = useState<string>("");
  const [sessionExists, setSessionExists] = useState<boolean>(false);
  const [sessionDetails, setSessionDetails] = useState<any>(null);
  const [showSessionModal, setShowSessionModal] = useState<boolean>(false);

  // Interactive Login State
  const [loginTab, setLoginTab] = useState<"credentials" | "cookies">("credentials");
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [loginStep, setLoginStep] = useState<"idle" | "authenticating" | "otp_required" | "success" | "failed">("idle");
  const [otpCode, setOtpCode] = useState<string>("");
  const [loginStatusMessage, setLoginStatusMessage] = useState<string>("");

  // Logs state
  const [logsList, setLogsList] = useState<LogEntry[]>([]);
  const [logFilter, setLogFilter] = useState<string>("all");
  const [logSearchQuery, setLogSearchQuery] = useState<string>("");

  // Data Explorer Tabs
  const [activeTab, setActiveTab] = useState<string>("coins");
  const [coinsList, setCoinsList] = useState<Coin[]>([]);
  const [messagesList, setMessagesList] = useState<GeneratedMessage[]>([]);

  // System Check State
  const [systemCheckResult, setSystemCheckResult] = useState<{
    playwrightInstalled: boolean;
    browsersPath: string;
    executablePath: string;
    executableExists: boolean;
    launchStatus: "success" | "failed";
    message: string;
    missingLibraries: string[];
  } | null>(null);
  const [isCheckingSystem, setIsCheckingSystem] = useState<boolean>(false);

  // Action Pending loaders
  const [isPending, setIsPending] = useState({
    login: false,
    fetch: false,
    generate: false,
    post: false,
    full: false,
    clear: false,
  });

  const isBusy =
    status === "Fetching" ||
    status === "Generating" ||
    status === "Posting" ||
    status === "Authenticating";

  // Browser Simulator Visual Typing State
  const [simText, setSimText] = useState("");
  const [simTargetCoin, setSimTargetCoin] = useState<string>("");
  const [simActive, setSimActive] = useState(false);
  const typingTimer = useRef<NodeJS.Timeout | null>(null);

  // Auto scroll logs console
  const [autoScroll, setAutoScroll] = useState(true);
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalEndRef = useRef<HTMLDivElement | null>(null);
  const lastLogsLength = useRef(0);

  // Fetch initial stats and list on page load
  useEffect(() => {
    fetchStats();
    fetchLogs();
    fetchSessionDetails();
    checkSystemHealth();
    
    // Initial fetch of lists
    fetch(resolveUrl("/output/last_trending.json"))
      .then(res => (res.ok ? res.json() : []))
      .then(data => setCoinsList(Array.isArray(data) ? data : []))
      .catch(() => {});
    fetch(resolveUrl("/output/generated_messages.json"))
      .then(res => (res.ok ? res.json() : []))
      .then(data => setMessagesList(Array.isArray(data) ? data : []))
      .catch(() => {});

    // Setup periodic polling for status & logs
    const interval = setInterval(() => {
      fetchStats();
      fetchLogs();
      // Poll data lists to keep them synchronized
      fetch(resolveUrl("/output/last_trending.json"))
        .then(res => (res.ok ? res.json() : []))
        .then(data => setCoinsList(Array.isArray(data) ? data : []))
        .catch(() => {});
      fetch(resolveUrl("/output/generated_messages.json"))
        .then(res => (res.ok ? res.json() : []))
        .then(data => setMessagesList(Array.isArray(data) ? data : []))
        .catch(() => {});
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  // Sync Simulator with current posting state
  useEffect(() => {
    if (status === "Posting" && currentCoin !== "N/A" && currentCoin !== simTargetCoin) {
      setSimTargetCoin(currentCoin);
      // Retrieve message for this coin to trigger simulator typing
      const matched = messagesList.find(m => `${m.name} (${m.symbol})` === currentCoin);
      if (matched) {
        startSimulatorTyping(matched.message);
      }
    } else if (status !== "Posting") {
      setSimActive(false);
      setSimText("");
    }
  }, [status, currentCoin, messagesList]);

  // Handle typing animation inside Browser Simulator
  const startSimulatorTyping = (fullMessage: string) => {
    if (typingTimer.current) clearInterval(typingTimer.current);
    setSimActive(true);
    setSimText("");
    let index = 0;
    typingTimer.current = setInterval(() => {
      if (index < fullMessage.length) {
        setSimText(prev => prev + fullMessage.charAt(index));
        index++;
      } else {
        if (typingTimer.current) clearInterval(typingTimer.current);
      }
    }, 45); // Typing speed
  };

  useEffect(() => {
    return () => {
      if (typingTimer.current) clearInterval(typingTimer.current);
    };
  }, []);

  // Fetch Current logs
  const fetchLogs = async () => {
    try {
      const res = await fetch(resolveUrl("/api/logs"));
      if (res.ok) {
        const data = await res.json();
        setLogsList(data.logs || []);
      }
    } catch (_) {}
  };

  // Fetch Session details
  const fetchSessionDetails = async () => {
    try {
      const res = await fetch(resolveUrl("/api/get-session"));
      if (res.ok) {
        const data = await res.json();
        setSessionExists(data.exists);
        setSessionDetails(data.details);
      }
    } catch (_) {}
  };

  // Fetch Status Stats
  const fetchStats = async () => {
    try {
      const res = await fetch(resolveUrl("/api/status"));
      if (res.ok) {
        const data = await res.json();
        setStatus(data.status);
        setRunMode(data.runMode);
        setTotalCoins(data.totalCoins);
        setGeneratedCount(data.generatedMessages);
        setPostedCount(data.postedCount);
        setFailedCount(data.failedCount);
        setResults(data.results || []);
        setProgressIndex(data.progressIndex);
        setCurrentCoin(data.currentCoin);
        setSessionStatus(data.sessionStatus);
        setApiStatus(data.apiStatus || { openai: false, cmc: false });
      }
    } catch (_) {}
  };

  // Run System & Playwright Environment Diagnostic Check
  const checkSystemHealth = async () => {
    setIsCheckingSystem(true);
    try {
      const res = await fetch(resolveUrl("/api/check-system"));
      if (res.ok) {
        const data = await res.json();
        setSystemCheckResult(data);
      } else {
        setSystemCheckResult({
          playwrightInstalled: false,
          browsersPath: "Error",
          executablePath: "Error",
          executableExists: false,
          launchStatus: "failed",
          message: "Failed to connect to system check endpoint.",
          missingLibraries: [],
        });
      }
    } catch (err) {
      setSystemCheckResult({
        playwrightInstalled: false,
        browsersPath: "Error",
        executablePath: "Error",
        executableExists: false,
        launchStatus: "failed",
        message: (err as Error).message || "Connection failed.",
        missingLibraries: [],
      });
    } finally {
      setIsCheckingSystem(false);
    }
  };

  // Lazy Load Data lists based on Active Tab
  useEffect(() => {
    if (activeTab === "coins") {
      fetch(resolveUrl("/output/last_trending.json"))
        .then(res => (res.ok ? res.json() : []))
        .then(data => setCoinsList(Array.isArray(data) ? data : []))
        .catch(() => setCoinsList([]));
    } else if (activeTab === "comments" || activeTab === "reports") {
      fetch(resolveUrl("/output/generated_messages.json"))
        .then(res => (res.ok ? res.json() : []))
        .then(data => setMessagesList(Array.isArray(data) ? data : []))
        .catch(() => setMessagesList([]));
    }
  }, [activeTab, status]);

  // Smart auto-scroll that only scrolls to the bottom if the user is already near the bottom and auto-scroll is enabled
  useEffect(() => {
    const container = terminalContainerRef.current;
    if (!container) return;

    if (logsList.length > lastLogsLength.current) {
      if (autoScroll) {
        const { scrollTop, scrollHeight, clientHeight } = container;
        // Check if user is scrolled near the bottom (within a 100px threshold of the newly rendered contents)
        const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
        if (isNearBottom) {
          // Instant direct scroll to bottom - never scrolls the parent browser page or iframe
          container.scrollTop = scrollHeight;
        }
      }
    }
    lastLogsLength.current = logsList.length;
  }, [logsList, autoScroll]);

  // Execute Endpoint Commands
  const runCommand = async (endpoint: string, pendingKey: keyof typeof isPending) => {
    setIsPending(prev => ({ ...prev, [pendingKey]: true }));
    try {
      const res = await fetch(resolveUrl(endpoint), { method: "POST" });
      const data = await res.json();
      fetchStats();
      fetchLogs();
      if (endpoint.includes("save-session") || endpoint.includes("clear-session")) {
        fetchSessionDetails();
      }
    } catch (error) {
      console.error(error);
    } finally {
      setIsPending(prev => ({ ...prev, [pendingKey]: false }));
    }
  };

  // Save state.json
  const handleSaveSession = async () => {
    if (!sessionJson.trim()) return;
    setIsPending(prev => ({ ...prev, login: true }));
    try {
      const res = await fetch(resolveUrl("/api/save-session"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stateJson: sessionJson })
      });
      if (res.ok) {
        setSessionJson("");
        setShowSessionModal(false);
        fetchSessionDetails();
        fetchStats();
      } else {
        const data = await res.json();
        alert(data.error || "Failed to parse session state JSON.");
      }
    } catch (error) {
      alert("Error saving session: " + (error as Error).message);
    } finally {
      setIsPending(prev => ({ ...prev, login: false }));
    }
  };

  // Start credential-based login
  const handleStartLogin = async () => {
    if (!email.trim() || !password.trim()) {
      alert("Please fill in both email and password.");
      return;
    }
    setLoginStep("authenticating");
    setLoginStatusMessage("Initializing secure browser, navigating to CoinMarketCap and entering credentials...");
    try {
      const res = await fetch(resolveUrl("/api/start-login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginStep("failed");
        setLoginStatusMessage(data.error || "Login attempt failed.");
        return;
      }

      if (data.status === "success") {
        setLoginStep("success");
        setLoginStatusMessage("Successfully authenticated! Your state.json is now active.");
        fetchSessionDetails();
        fetchStats();
      } else if (data.status === "requires_otp") {
        setLoginStep("otp_required");
        setLoginStatusMessage(data.message || "Enter the 6-digit verification code sent to your email.");
      } else {
        setLoginStep("failed");
        setLoginStatusMessage(data.message || "Authentication attempt was unsuccessful.");
      }
    } catch (err) {
      setLoginStep("failed");
      setLoginStatusMessage("Error connecting to login service: " + (err as Error).message);
    }
  };

  // Submit OTP / Verification code
  const handleSubmitOtp = async () => {
    if (!otpCode.trim() || otpCode.length < 4) {
      alert("Please enter a valid verification code.");
      return;
    }
    setLoginStep("authenticating");
    setLoginStatusMessage("Submitting 6-digit code and verifying active session, please wait...");
    try {
      const res = await fetch(resolveUrl("/api/submit-otp"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otp: otpCode })
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginStep("failed");
        setLoginStatusMessage(data.error || "OTP verification failed.");
        return;
      }

      if (data.status === "success") {
        setLoginStep("success");
        setLoginStatusMessage("Success! Your CoinMarketCap session is fully verified and saved to state.json.");
        setOtpCode("");
        fetchSessionDetails();
        fetchStats();
      } else {
        setLoginStep("failed");
        setLoginStatusMessage(data.message || "Failed to verify security code.");
      }
    } catch (err) {
      setLoginStep("failed");
      setLoginStatusMessage("Error submitting verification code: " + (err as Error).message);
    }
  };

  // Cancel login sequence
  const handleCancelLogin = async () => {
    try {
      await fetch(resolveUrl("/api/cancel-login"), { method: "POST" });
    } catch (_) {}
    setLoginStep("idle");
    setLoginStatusMessage("");
    setOtpCode("");
  };

  const handleResetLoginState = () => {
    setLoginStep("idle");
    setLoginStatusMessage("");
    setOtpCode("");
  };

  // State for tracking manual retry indicators
  const [individualLoading, setIndividualLoading] = useState<Record<string, "retry" | null>>({});

  // Individual Coin manual actions
  const handleRetrySingle = async (symbol: string) => {
    setIndividualLoading(prev => ({ ...prev, [symbol]: "retry" }));
    try {
      const res = await fetch(resolveUrl("/api/retry-single"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol })
      });
      const data = await res.json();
      if (res.ok) {
        fetchStats();
        fetchLogs();
      } else {
        alert(data.error || "Manual retry failed.");
      }
    } catch (err) {
      alert("Network error: " + (err as Error).message);
    } finally {
      setIndividualLoading(prev => ({ ...prev, [symbol]: null }));
    }
  };

  // Toggle runMode state
  const handleToggleRunMode = async (mode: string) => {
    try {
      const res = await fetch(resolveUrl("/api/set-run-mode"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode })
      });
      if (res.ok) {
        const data = await res.json();
        setRunMode(data.runMode);
      }
    } catch (error) {
      console.error(error);
    }
  };

  // Log filter Logic
  const filteredLogs = logsList.filter(l => {
    const matchesLevel = logFilter === "all" || l.level === logFilter;
    const matchesQuery = !logSearchQuery.trim() || l.message.toLowerCase().includes(logSearchQuery.toLowerCase());
    return matchesLevel && matchesQuery;
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans flex flex-col selection:bg-emerald-500 selection:text-slate-950">
      
      {/* HEADER NAVBAR */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-md sticky top-0 z-50 px-6 py-4 flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-emerald-500/10 text-emerald-400 rounded-xl border border-emerald-500/20 shadow-lg shadow-emerald-500/5 animate-pulse">
            <Activity className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
              CoinMarketCap Bot Console
              <span className="text-[10px] uppercase tracking-widest font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                PRO v2.0
              </span>
            </h1>
            <p className="text-xs text-slate-400">Automated Community Commenting and Growth Driver</p>
          </div>
        </div>

        {/* TOP STATUS ROW */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 bg-slate-950 px-3.5 py-1.5 rounded-lg border border-slate-800 text-xs text-slate-300">
            <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block animate-ping"></span>
            Server: <span className="font-semibold text-emerald-400">ONLINE</span>
          </div>

          <div className="flex items-center gap-2 bg-slate-950 px-3.5 py-1.5 rounded-lg border border-slate-800 text-xs">
            <span className="text-slate-400 font-mono">OpenAI API:</span>
            {apiStatus.openai ? (
              <span className="text-emerald-400 font-bold flex items-center gap-1">
                <CheckCircle className="h-3 w-3" /> Enabled (gpt-4o-mini)
              </span>
            ) : (
              <span className="text-amber-400 font-bold flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> Rule-Based Mode
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 bg-slate-950 px-3.5 py-1.5 rounded-lg border border-slate-800 text-xs">
            <span className="text-slate-400 font-mono">CMC Pro:</span>
            {apiStatus.cmc ? (
              <span className="text-emerald-400 font-bold flex items-center gap-1">
                <CheckCircle className="h-3 w-3" /> Connected
              </span>
            ) : (
              <span className="text-blue-400 font-bold flex items-center gap-1">
                <Globe className="h-3 w-3" /> CG Public
              </span>
            )}
          </div>
        </div>
      </header>

      {/* DASHBOARD CONTENT BODY */}
      <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">

        {/* SYSTEM ENVIRONMENT DIAGNOSTICS CARD */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl transition-all duration-350 hover:border-slate-700/80">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4 mb-4">
            <div className="flex items-center gap-3">
              <span className={`p-2 rounded-lg border flex items-center justify-center ${
                systemCheckResult?.success
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                  : "bg-red-500/10 text-red-400 border-red-500/20"
              }`}>
                <Activity className="h-5 w-5" />
              </span>
              <div>
                <h2 className="font-bold text-white tracking-tight text-base flex items-center gap-2">
                  System Environment Diagnostics
                  {isCheckingSystem ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin text-slate-400" />
                  ) : systemCheckResult?.success ? (
                    <span className="text-xs bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded border border-emerald-500/20 font-medium">
                      Healthy
                    </span>
                  ) : (
                    <span className="text-xs bg-red-500/10 text-red-400 px-2 py-0.5 rounded border border-red-500/20 font-medium">
                      Issue Detected
                    </span>
                  )}
                </h2>
                <p className="text-xs text-slate-400">Verifies backend browser runtimes, executable existence, and system libraries</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={checkSystemHealth}
                disabled={isCheckingSystem}
                className="px-3.5 py-1.5 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg text-xs text-slate-300 font-semibold flex items-center gap-1.5 transition disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isCheckingSystem ? "animate-spin" : ""}`} />
                Re-Run Diagnostics
              </button>

              {runMode === "Real Browser" ? (
                <button
                  onClick={() => handleToggleRunMode("Simulated Browser")}
                  className="px-3.5 py-1.5 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 rounded-lg text-xs text-blue-400 font-semibold transition"
                >
                  Switch to Simulated Mode
                </button>
              ) : (
                <button
                  onClick={() => handleToggleRunMode("Real Browser")}
                  className="px-3.5 py-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 rounded-lg text-xs text-emerald-400 font-semibold transition"
                >
                  Activate Real Browser
                </button>
              )}
            </div>
          </div>

          {!systemCheckResult ? (
            <div className="py-6 flex flex-col items-center justify-center text-slate-400 space-y-2">
              <RefreshCw className="h-6 w-6 animate-spin text-blue-500" />
              <p className="text-xs">Proactively querying system dependencies check...</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* SUB-CHECKS COLUMN */}
              <div className="space-y-3 border-r border-slate-800/60 pr-6">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Checklist</h3>
                
                {/* CHECK 1 */}
                <div className="flex items-start gap-2.5">
                  {systemCheckResult.playwrightInstalled ? (
                    <span className="p-1 bg-emerald-500/10 text-emerald-400 rounded-full border border-emerald-500/20 mt-0.5">
                      <CheckCircle className="h-3.5 w-3.5" />
                    </span>
                  ) : (
                    <span className="p-1 bg-red-500/10 text-red-400 rounded-full border border-red-500/20 mt-0.5">
                      <AlertTriangle className="h-3.5 w-3.5" />
                    </span>
                  )}
                  <div>
                    <h4 className="text-xs font-semibold text-white font-mono">Playwright</h4>
                    <p className="text-[10px] text-slate-400">
                      {systemCheckResult.playwrightInstalled ? "Framework is installed and loaded" : "Failed to load playwright"}
                    </p>
                  </div>
                </div>

                {/* CHECK 2 */}
                <div className="flex items-start gap-2.5">
                  {systemCheckResult.executableExists ? (
                    <span className="p-1 bg-emerald-500/10 text-emerald-400 rounded-full border border-emerald-500/20 mt-0.5">
                      <CheckCircle className="h-3.5 w-3.5" />
                    </span>
                  ) : (
                    <span className="p-1 bg-red-500/10 text-red-400 rounded-full border border-red-500/20 mt-0.5">
                      <AlertTriangle className="h-3.5 w-3.5" />
                    </span>
                  )}
                  <div>
                    <h4 className="text-xs font-semibold text-white font-mono">Chromium Binary</h4>
                    <p className="text-[10px] text-slate-400">
                      {systemCheckResult.executableExists ? "Executable exists on disk" : "No executable found at path"}
                    </p>
                  </div>
                </div>

                {/* CHECK 3 */}
                <div className="flex items-start gap-2.5">
                  {systemCheckResult.launchStatus === "success" ? (
                    <span className="p-1 bg-emerald-500/10 text-emerald-400 rounded-full border border-emerald-500/20 mt-0.5">
                      <CheckCircle className="h-3.5 w-3.5" />
                    </span>
                  ) : (
                    <span className="p-1 bg-amber-500/10 text-amber-400 rounded-full border border-amber-500/20 mt-0.5">
                      <AlertTriangle className="h-3.5 w-3.5" />
                    </span>
                  )}
                  <div>
                    <h4 className="text-xs font-semibold text-white font-mono">Shared OS Libraries</h4>
                    <p className="text-[10px] text-slate-400">
                      {systemCheckResult.launchStatus === "success" ? "All OS dependencies satisfied" : "Missing shared libraries detected"}
                    </p>
                  </div>
                </div>
              </div>

              {/* DETAILED ENVIRONMENT COLUMN */}
              <div className="md:col-span-2 space-y-3 flex flex-col justify-between">
                <div>
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Environment Details</h3>
                  <div className="bg-slate-950 rounded-xl p-3 border border-slate-850 space-y-2 text-[11px] font-mono leading-relaxed">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                      <span className="text-slate-500">PLAYWRIGHT_BROWSERS_PATH:</span>
                      <span className="text-slate-300 truncate max-w-sm">{systemCheckResult.browsersPath}</span>
                    </div>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                      <span className="text-slate-500">Executable Path:</span>
                      <span className="text-slate-300 truncate max-w-sm" title={systemCheckResult.executablePath}>{systemCheckResult.executablePath}</span>
                    </div>
                    <div className="border-t border-slate-900 pt-2 flex flex-col gap-1">
                      <span className="text-slate-500">Verification Result:</span>
                      <span className={`font-semibold ${systemCheckResult.success ? "text-emerald-400" : "text-amber-400"}`}>
                        {systemCheckResult.message}
                      </span>
                    </div>
                  </div>
                </div>

                {/* HELP BANNER FOR ACTIONABLE FIX */}
                {systemCheckResult.missingLibraries.length > 0 && (
                  <div className="p-3 bg-amber-500/5 border border-amber-500/15 rounded-xl flex items-start gap-2.5 text-[10px] text-slate-400">
                    <AlertTriangle className="h-4 w-4 text-amber-400 flex-shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="font-semibold text-amber-400">Actionable Resolution:</p>
                      <p>
                        Detected missing shared libraries in this local sandbox/container environment (such as <code className="text-amber-300">{systemCheckResult.missingLibraries.join(", ")}</code>). We have fully configured a <code className="text-blue-400">nixpacks.toml</code> and <code className="text-blue-400">railway.toml</code> at the root of the project to automatically pre-install these OS dependencies upon your production, AWS, or cloud deployment!
                      </p>
                      <p>
                        To continue testing and development seamlessly, we suggest switching to <strong>Simulated Browser Mode</strong> (using the button above).
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        {/* ROW 1: ACTIONS, SIMULATOR, SESSION */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* CONTROL PANEL CARD (7 cols) */}
          <section id="controls-panel" className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col justify-between transition-all duration-350 hover:border-slate-700/80">
            <div>
              <div className="flex items-center justify-between mb-5">
                <h2 className="font-bold text-white tracking-tight flex items-center gap-2">
                  <span className="p-1.5 bg-blue-500/10 text-blue-400 rounded-lg border border-blue-500/20">
                    <Layers className="h-4 w-4" />
                  </span>
                  Control Center
                </h2>
                <span className={`text-[11px] font-mono uppercase tracking-widest px-2.5 py-1 rounded-full ${
                  status === "Posting" ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" :
                  status === "Generating" ? "bg-purple-500/10 text-purple-400 border border-purple-500/20" :
                  status === "Fetching" ? "bg-blue-500/10 text-blue-400 border border-blue-500/20" :
                  "bg-slate-800 text-slate-400 border border-slate-700"
                }`}>
                  State: {status}
                </span>
              </div>

              {/* REAL BROWSER ENFORCEMENT BANNER */}
              <div className="mb-5 p-3.5 bg-emerald-500/5 rounded-xl border border-emerald-500/20 space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold">
                  <span className="text-emerald-400 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    Live Run Mode:
                  </span>
                  <span className="text-[10px] font-mono font-bold uppercase tracking-wide px-2 py-0.5 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                    Real Browser (Playwright)
                  </span>
                </div>
                <p className="text-[10px] text-slate-400 leading-normal">
                  Simulation mode has been disabled. The bot executes using a real, headless Playwright engine running on the backend container. It will post comments directly to CoinMarketCap using your uploaded account credentials in <code className="text-emerald-400 font-mono">auth/state.json</code>.
                </p>
              </div>

              {/* CORE METHOD CONTROLS */}
              <div className="space-y-3.5">
                <button
                  onClick={() => runCommand("/api/check-login", "login")}
                  disabled={isPending.login || isBusy}
                  className="w-full text-left p-3 rounded-xl bg-slate-950 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 transition flex items-center justify-between group disabled:opacity-50"
                  id="btn-login"
                >
                  <div className="flex items-center gap-3">
                    <span className="p-2 bg-emerald-500/10 text-emerald-400 rounded-lg group-hover:bg-emerald-500/20 transition">
                      <CheckCircle className="h-4.5 w-4.5" />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold text-white">Check Session</h3>
                      <p className="text-[11px] text-slate-400">Verify login state to CoinMarketCap</p>
                    </div>
                  </div>
                  {isPending.login ? (
                    <RefreshCw className="h-4 w-4 text-emerald-400 animate-spin" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-slate-600 group-hover:text-slate-300 transition" />
                  )}
                </button>

                <button
                  onClick={() => runCommand("/api/fetch-trending", "fetch")}
                  disabled={isPending.fetch || isBusy}
                  className="w-full text-left p-3 rounded-xl bg-slate-950 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 transition flex items-center justify-between group disabled:opacity-50"
                  id="btn-fetch"
                >
                  <div className="flex items-center gap-3">
                    <span className="p-2 bg-blue-500/10 text-blue-400 rounded-lg group-hover:bg-blue-500/20 transition">
                      <Search className="h-4.5 w-4.5" />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold text-white">Fetch Trending</h3>
                      <p className="text-[11px] text-slate-400">Grab live listings and dynamic metrics</p>
                    </div>
                  </div>
                  {isPending.fetch ? (
                    <RefreshCw className="h-4 w-4 text-blue-400 animate-spin" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-slate-600 group-hover:text-slate-300 transition" />
                  )}
                </button>

                <button
                  onClick={() => runCommand("/api/generate-messages", "generate")}
                  disabled={isPending.generate || isBusy || totalCoins === 0}
                  className="w-full text-left p-3 rounded-xl bg-slate-950 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 transition flex items-center justify-between group disabled:opacity-50"
                  id="btn-generate"
                >
                  <div className="flex items-center gap-3">
                    <span className="p-2 bg-purple-500/10 text-purple-400 rounded-lg group-hover:bg-purple-500/20 transition">
                      <BookOpen className="h-4.5 w-4.5" />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold text-white">Generate Comments</h3>
                      <p className="text-[11px] text-slate-400">Craft human comments using OpenAI gpt-4o-mini</p>
                    </div>
                  </div>
                  {isPending.generate ? (
                    <RefreshCw className="h-4 w-4 text-purple-400 animate-spin" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-slate-600 group-hover:text-slate-300 transition" />
                  )}
                </button>

                {status === "Posting" ? (
                  <button
                    onClick={() => runCommand("/api/stop-posting", "post")}
                    className="w-full p-3.5 rounded-xl bg-red-600/10 hover:bg-red-600/20 border border-red-500/20 text-red-400 hover:text-red-300 transition flex items-center justify-center gap-2.5 font-semibold text-sm cursor-pointer animate-pulse"
                    id="btn-pause"
                  >
                    <Pause className="h-4.5 w-4.5" /> Pause posting sequence
                  </button>
                ) : (
                  <button
                    onClick={() => runCommand("/api/post-chat", "post")}
                    disabled={isPending.post || isBusy || generatedCount === 0}
                    className="w-full p-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition flex items-center justify-center gap-2.5 font-bold text-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    id="btn-start"
                  >
                    <Play className="h-4.5 w-4.5 fill-slate-950" /> Start posting sequence
                  </button>
                )}
              </div>
            </div>

            {/* FULL AUTOMATION SEQUENCE BUTTON */}
            <div className="mt-6 pt-5 border-t border-slate-800 flex flex-col gap-3">
              <button
                onClick={() => runCommand("/api/full-flow", "full")}
                disabled={isPending.full || isBusy}
                className="w-full p-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 transition flex items-center justify-center gap-2 font-extrabold text-sm shadow-lg shadow-emerald-500/10 disabled:opacity-50 cursor-pointer"
                id="btn-full-flow"
              >
                {isPending.full ? (
                  <RefreshCw className="h-4.5 w-4.5 animate-spin text-slate-950" />
                ) : (
                  <Activity className="h-4.5 w-4.5" />
                )}
                Run Full Automated Bot Cycle
              </button>
              <div className="flex items-center justify-between text-[11px] text-slate-500">
                <span>Runs fetch, generate & post in a row</span>
                <button
                  onClick={() => runCommand("/api/clear-all", "clear")}
                  disabled={isPending.clear || isBusy}
                  className="text-red-400 hover:text-red-300 transition-all duration-200 active:scale-95 flex items-center gap-1 font-semibold disabled:opacity-55"
                  id="btn-clear-stats"
                >
                  <Trash2 className="h-3 w-3" /> Reset Storage
                </button>
              </div>
            </div>
          </section>

          {/* PLAYWRIGHT SESSION BUILDER (5 cols) */}
          <section id="session-builder" className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col justify-between transition-all duration-350 hover:border-slate-700/80">
            <div>
              <div className="flex items-center justify-between mb-4.5">
                <h2 className="font-bold text-white tracking-tight flex items-center gap-2">
                  <span className="p-1.5 bg-amber-500/10 text-amber-400 rounded-lg border border-amber-500/20">
                    <Key className="h-4 w-4" />
                  </span>
                  Auth Configuration
                </h2>
                <span className={`text-[10px] uppercase font-mono px-2 py-0.5 rounded border ${
                  sessionExists ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" : "bg-amber-500/10 border-amber-500/20 text-amber-400"
                }`}>
                  {sessionExists ? "State Loaded" : "Unconfigured"}
                </span>
              </div>

              {/* Session State stats */}
              <div className="space-y-4">
                <div className="p-3 bg-slate-950 rounded-xl border border-slate-800/80 space-y-2">
                  <div className="text-[11px] text-slate-400">Storage Location:</div>
                  <div className="text-xs font-mono text-slate-200 truncate">auth/state.json</div>
                  
                  {sessionExists && sessionDetails ? (
                    <div className="grid grid-cols-2 gap-2 pt-1 text-[10px]">
                      <div>
                        <span className="text-slate-500 block">File Size:</span>
                        <span className="text-slate-300 font-medium">{(sessionDetails.sizeBytes / 1024).toFixed(2)} KB</span>
                      </div>
                      <div>
                        <span className="text-slate-500 block">Last Saved:</span>
                        <span className="text-slate-300 font-medium truncate block">
                          {new Date(sessionDetails.updatedAt).toLocaleTimeString()}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="text-[11px] text-amber-400 font-medium bg-amber-500/5 p-2 rounded border border-amber-500/10">
                      No state.json session found. Bot will run in high-fidelity simulation mode.
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <button
                    onClick={() => setShowSessionModal(true)}
                    disabled={isBusy}
                    className="w-full py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 hover:text-white transition flex items-center justify-center gap-2 font-semibold text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Upload className="h-3.5 w-3.5" /> Configure Cookie Session
                  </button>

                  {sessionExists && (
                    <button
                      onClick={() => runCommand("/api/clear-session", "login")}
                      disabled={isBusy}
                      className="w-full py-2 px-4 rounded-xl bg-red-600/10 hover:bg-red-600/20 text-red-400 border border-red-500/10 transition flex items-center justify-center gap-2 font-medium text-[11px] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Delete auth/state.json
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-850 text-[11px] text-slate-400">
              <span className="font-semibold text-white">How it works:</span> Import your logged-in CoinMarketCap state.json cookies into the workspace. The bot automatically routes sessions into Playwright commands.
            </div>
          </section>

        </div>

        {/* ROW 2: ACTIVE PROGRESS, SECRET KEY MATRIX, LOG CONSOLE */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* PROGRESS CARD (4 cols) */}
          <section className="lg:col-span-4 bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col justify-between">
            <div className="space-y-4">
              <h2 className="font-bold text-white tracking-tight flex items-center gap-2">
                <span className="p-1.5 bg-emerald-500/10 text-emerald-400 rounded-lg border border-emerald-500/20">
                  <Activity className="h-4 w-4" />
                </span>
                Active Progress
              </h2>

              <div className="space-y-3">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-400">Selected Coin:</span>
                  <span className="font-mono text-white bg-slate-950 px-2.5 py-1 rounded border border-slate-800">
                    {currentCoin}
                  </span>
                </div>

                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-400">Total coins in run:</span>
                  <span className="font-bold text-slate-200">{totalCoins}</span>
                </div>

                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-400">Comments generated:</span>
                  <span className="font-bold text-slate-200">{generatedCount}</span>
                </div>

                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-400">Posted count:</span>
                  <span className="font-bold text-emerald-400">{postedCount}</span>
                </div>

                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-400">Remaining count:</span>
                  <span className="font-bold text-slate-400">{Math.max(0, totalCoins - progressIndex)}</span>
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-800 space-y-2">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-slate-400">Batch progress:</span>
                <span className="text-emerald-400 font-bold">{totalCoins > 0 ? Math.round((progressIndex / totalCoins) * 100) : 0}%</span>
              </div>
              <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-850">
                <div
                  className="bg-gradient-to-r from-emerald-500 to-teal-500 h-full transition-all duration-500"
                  style={{ width: `${totalCoins > 0 ? (progressIndex / totalCoins) * 100 : 0}%` }}
                ></div>
              </div>
            </div>
          </section>

          {/* SECRETS DIRECTORY GRID (3 cols) */}
          <section className="lg:col-span-3 bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col justify-between">
            <div>
              <h2 className="font-bold text-white tracking-tight flex items-center gap-2 mb-4">
                <span className="p-1.5 bg-blue-500/10 text-blue-400 rounded-lg border border-blue-500/20">
                  <Key className="h-4 w-4" />
                </span>
                Active Secrets Key Matrix
              </h2>

              <div className="space-y-3.5">
                <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 flex items-center justify-between">
                  <div>
                    <span className="text-[10px] font-mono text-slate-500 block uppercase">Variable name</span>
                    <span className="text-xs font-semibold text-slate-200 font-mono">OPENAI_API_KEY</span>
                  </div>
                  <span className={`text-[10px] px-2.5 py-1 rounded font-bold uppercase tracking-wider ${
                    apiStatus.openai ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-slate-800 text-slate-500 border border-slate-750"
                  }`}>
                    {apiStatus.openai ? "Active" : "Unset"}
                  </span>
                </div>

                <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 flex items-center justify-between">
                  <div>
                    <span className="text-[10px] font-mono text-slate-500 block uppercase">Variable name</span>
                    <span className="text-xs font-semibold text-slate-200 font-mono">CMC_API_KEY</span>
                  </div>
                  <span className={`text-[10px] px-2.5 py-1 rounded font-bold uppercase tracking-wider ${
                    apiStatus.cmc ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-slate-800 text-slate-500 border border-slate-750"
                  }`}>
                    {apiStatus.cmc ? "Active" : "Unset"}
                  </span>
                </div>
              </div>
            </div>

            <div className="text-[11px] text-slate-500 mt-4 leading-relaxed flex gap-2">
              <HelpCircle className="h-5 w-5 text-blue-400 flex-shrink-0" />
              <span>Configure these server-side tokens in the <strong>.env</strong> file or environment configuration.</span>
            </div>
          </section>

          {/* LOG CONSOLE TERMINAL (5 cols) */}
          <section className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col justify-between">
            <div className="flex flex-col gap-3.5 mb-3.5 border-b border-slate-850 pb-3">
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-white tracking-tight flex items-center gap-2">
                  <span className="p-1.5 bg-slate-800 text-emerald-400 rounded-lg border border-slate-700">
                    <TerminalIcon className="h-4 w-4" />
                  </span>
                  Interactive Logs Console
                </h2>
                <button
                  onClick={() => runCommand("/api/clear-all", "clear")}
                  className="p-1 text-slate-500 hover:text-red-400 rounded hover:bg-slate-800 transition"
                  title="Clear console"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              
              <div className="flex flex-wrap items-center gap-2">
                {/* Search query input */}
                <input
                  type="text"
                  placeholder="Filter logs by keyword..."
                  value={logSearchQuery}
                  onChange={(e) => setLogSearchQuery(e.target.value)}
                  className="flex-1 bg-slate-950 border border-slate-800 rounded px-2.5 py-1 text-[11px] text-slate-300 focus:outline-none focus:border-emerald-500 placeholder-slate-600 font-mono"
                />

                {/* Auto-scroll toggle indicator/button */}
                <button
                  onClick={() => {
                    const nextVal = !autoScroll;
                    setAutoScroll(nextVal);
                    if (nextVal && terminalContainerRef.current) {
                      terminalContainerRef.current.scrollTop = terminalContainerRef.current.scrollHeight;
                    }
                  }}
                  className={`px-2 py-1 text-[10px] font-bold rounded border transition flex items-center gap-1 cursor-pointer ${
                    autoScroll
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20"
                      : "bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200"
                  }`}
                  title={autoScroll ? "Pause auto-scrolling when new logs arrive" : "Resume auto-scrolling to the bottom"}
                >
                  <ArrowDown className={`h-3 w-3 ${autoScroll ? "animate-pulse" : ""}`} />
                  Scroll: {autoScroll ? "ON" : "PAUSED"}
                </button>

                {/* Log level selector */}
                <select
                  value={logFilter}
                  onChange={(e) => setLogFilter(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-[10px] font-semibold text-slate-400 cursor-pointer focus:outline-none focus:border-emerald-500"
                >
                  <option value="all">ALL LOGS</option>
                  <option value="info">INFO</option>
                  <option value="success">SUCCESS</option>
                  <option value="warning">WARNING</option>
                  <option value="error">ERROR</option>
                </select>
              </div>
            </div>

            {/* Terminal console */}
            <div 
              ref={terminalContainerRef}
              className="bg-slate-950 rounded-xl border border-slate-850 p-4 h-[360px] overflow-y-auto font-mono text-[11px] space-y-1.5 leading-relaxed shadow-inner"
            >
              {filteredLogs.length === 0 ? (
                <div className="text-slate-600 italic text-center pt-12">No console messages matching filter.</div>
              ) : (
                filteredLogs.map((log, index) => {
                  let colorClass = "text-slate-300";
                  if (log.level === "success") colorClass = "text-emerald-400";
                  else if (log.level === "warning") colorClass = "text-amber-400";
                  else if (log.level === "error") colorClass = "text-red-400 font-semibold";
                  else if (log.level === "info") colorClass = "text-blue-400";

                  return (
                    <div key={index} className="flex gap-2 items-start hover:bg-slate-900/40 p-0.5 rounded transition">
                      <span className="text-slate-600 flex-shrink-0 select-none">[{log.timestamp}]</span>
                      <span className={colorClass}>{log.message}</span>
                    </div>
                  );
                })
              )}
              <div ref={terminalEndRef}></div>
            </div>
          </section>

        </div>

        {/* ROW 3: STORAGE AND REPORTS DATA EXPLORER (Full width) */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-5">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
            <h2 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
              <span className="p-1.5 bg-blue-500/10 text-blue-400 rounded-lg border border-blue-500/20">
                <Database className="h-5 w-5" />
              </span>
              Storage & Report Explorer
            </h2>

            {/* Exporter selector tabs */}
            <div className="flex flex-wrap gap-1 bg-slate-950 p-1 rounded-xl border border-slate-850">
              <button
                onClick={() => setActiveTab("coins")}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold tracking-wide transition-all ${
                  activeTab === "coins" ? "bg-slate-800 text-white shadow" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                1. Trending Coins
              </button>
              <button
                onClick={() => setActiveTab("comments")}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold tracking-wide transition-all ${
                  activeTab === "comments" ? "bg-slate-800 text-white shadow" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                2. Generated Comments
              </button>
              <button
                onClick={() => setActiveTab("results")}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold tracking-wide transition-all ${
                  activeTab === "results" ? "bg-slate-800 text-white shadow" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                3. Post Submissions ({results.length})
              </button>
              <button
                onClick={() => setActiveTab("reports")}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold tracking-wide transition-all ${
                  activeTab === "reports" ? "bg-slate-800 text-white shadow" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                4. CSV Exports & Reports
              </button>
            </div>
          </div>

          {/* TAB WINDOW CONTENT */}
          <div className="min-h-[200px]">
            
            {/* TAB 1: COINS LIST */}
            {activeTab === "coins" && (
              <div className="overflow-x-auto rounded-xl border border-slate-850">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-950 text-slate-400 uppercase text-[10px] tracking-widest border-b border-slate-850 font-mono">
                    <tr>
                      <th className="py-3 px-4">Rank</th>
                      <th className="py-3 px-4">Slug / Asset</th>
                      <th className="py-3 px-4">Price</th>
                      <th className="py-3 px-4">1h Change</th>
                      <th className="py-3 px-4">24h Change</th>
                      <th className="py-3 px-4">7d Change</th>
                      <th className="py-3 px-4">Market Cap</th>
                      <th className="py-3 px-4">24h Volume</th>
                      <th className="py-3 px-4 text-right">Interactive link</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-850/60 bg-slate-900/40">
                    {coinsList.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="py-8 text-center text-slate-500 italic">
                          No coin data present in storage. Trigger "Fetch Trending" to populate!
                        </td>
                      </tr>
                    ) : (
                      coinsList.map((coin, index) => (
                        <tr key={index} className="hover:bg-slate-800/20 transition-all">
                          <td className="py-3.5 px-4 font-mono font-semibold text-slate-400">
                            #{coin.cmc_rank || index + 1}
                          </td>
                          <td className="py-3.5 px-4">
                            <div className="font-bold text-white leading-none">{coin.name}</div>
                            <span className="text-[10px] font-mono text-slate-500 tracking-wide uppercase">{coin.symbol}</span>
                          </td>
                          <td className="py-3.5 px-4 font-mono font-medium text-slate-200">
                            ${coin.price >= 1 ? coin.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : coin.price.toFixed(6)}
                          </td>
                          <td className={`py-3.5 px-4 font-mono font-semibold ${
                            (coin.change_1h || 0) >= 0 ? "text-emerald-400" : "text-rose-400"
                          }`}>
                            {(coin.change_1h || 0) >= 0 ? "+" : ""}{(coin.change_1h || 0).toFixed(2)}%
                          </td>
                          <td className={`py-3.5 px-4 font-mono font-semibold ${
                            coin.change_24h >= 0 ? "text-emerald-400" : "text-rose-400"
                          }`}>
                            {coin.change_24h >= 0 ? "+" : ""}{coin.change_24h.toFixed(2)}%
                          </td>
                          <td className={`py-3.5 px-4 font-mono font-semibold ${
                            (coin.change_7d || 0) >= 0 ? "text-emerald-400" : "text-rose-400"
                          }`}>
                            {(coin.change_7d || 0) >= 0 ? "+" : ""}{(coin.change_7d || 0).toFixed(2)}%
                          </td>
                          <td className="py-3.5 px-4 font-mono text-slate-300">
                            ${coin.market_cap.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </td>
                          <td className="py-3.5 px-4 font-mono text-slate-300">
                            ${coin.volume_24h.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </td>
                          <td className="py-3.5 px-4 text-right">
                            <a
                              href={coin.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-emerald-400 hover:text-emerald-300 hover:underline inline-flex items-center gap-1 font-semibold"
                            >
                              Open Market <ChevronRight className="h-3 w-3" />
                            </a>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {/* TAB 2: GENERATED COMMENTS */}
            {activeTab === "comments" && (() => {
              const pendingCoins = messagesList.filter(msgItem => !results.some(r => r.symbol.toLowerCase() === msgItem.symbol.toLowerCase()));
              const failedCoins = messagesList.filter(msgItem => results.some(r => r.symbol.toLowerCase() === msgItem.symbol.toLowerCase() && r.status !== "success"));
              return (
                <div className="space-y-8">
                  {/* Active Automated Posting Queue */}
                  <div className="space-y-3">
                    <h3 className="text-sm font-bold text-white tracking-tight flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                      Active Automated Posting Queue ({pendingCoins.length} coins pending)
                    </h3>
                    <div className="overflow-x-auto rounded-xl border border-slate-850">
                      <table className="w-full text-left text-xs border-collapse">
                        <thead className="bg-slate-950 text-slate-400 uppercase text-[10px] tracking-widest border-b border-slate-850 font-mono">
                          <tr>
                            <th className="py-3 px-4 w-[100px]">Sequence</th>
                            <th className="py-3 px-4 w-[150px]">Asset</th>
                            <th className="py-3 px-4 w-[120px]">Sentiment</th>
                            <th className="py-3 px-4">Comment Message</th>
                            <th className="py-3 px-4 text-right w-[150px]">Link</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-850/60 bg-slate-900/40">
                          {pendingCoins.length === 0 ? (
                            <tr>
                              <td colSpan={5} className="py-6 text-center text-slate-500 italic">
                                No pending coins in queue. All coins have been processed!
                              </td>
                            </tr>
                          ) : (
                            pendingCoins.map((item, index) => (
                              <tr key={index} className="hover:bg-slate-800/20 transition-all">
                                <td className="py-4 px-4 font-mono">
                                  <span className="text-[10px] text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20 font-bold">
                                    Seq #{index + 1}
                                  </span>
                                </td>
                                <td className="py-4 px-4 font-bold text-white">
                                  <div className="leading-none">{item.name}</div>
                                  <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">{item.symbol}</span>
                                </td>
                                <td className="py-4 px-4">
                                  {item.sentiment === "bearish" ? (
                                    <span className="px-2 py-0.5 rounded text-[10px] bg-rose-500/10 text-rose-400 border border-rose-500/20 uppercase tracking-wider font-bold">
                                      Bearish
                                    </span>
                                  ) : (
                                    <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 uppercase tracking-wider font-bold">
                                      Bullish
                                    </span>
                                  )}
                                </td>
                                <td className="py-4 px-4 font-mono text-slate-300 leading-relaxed italic">
                                  "{item.message}"
                                </td>
                                <td className="py-4 px-4 text-right">
                                  <a
                                    href={item.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-blue-400 hover:text-blue-300 hover:underline inline-flex items-center gap-1 font-semibold"
                                  >
                                    Open <ChevronRight className="h-3 w-3" />
                                  </a>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Failed/Unsuccessful Submissions */}
                  <div className="space-y-3 pt-4 border-t border-slate-850">
                    <h3 className="text-sm font-bold text-white tracking-tight flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-rose-500"></span>
                      Failed / Unsuccessful Submissions ({failedCoins.length} failures)
                    </h3>
                    <div className="overflow-x-auto rounded-xl border border-slate-850">
                      <table className="w-full text-left text-xs border-collapse">
                        <thead className="bg-slate-950 text-slate-400 uppercase text-[10px] tracking-widest border-b border-slate-850 font-mono">
                          <tr>
                            <th className="py-3 px-4 w-[150px]">Asset</th>
                            <th className="py-3 px-4 w-[120px]">Sentiment</th>
                            <th className="py-3 px-4">Error/Status Details</th>
                            <th className="py-3 px-4 text-center w-[150px]">Manual Retry Action</th>
                            <th className="py-3 px-4 text-right w-[150px]">Link</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-850/60 bg-slate-900/40">
                          {failedCoins.length === 0 ? (
                            <tr>
                              <td colSpan={5} className="py-6 text-center text-slate-500 italic">
                                No unsuccessful submissions found. Smooth sailing!
                              </td>
                            </tr>
                          ) : (
                            failedCoins.map((item, index) => {
                              const resEntry = results.find(r => r.symbol.toLowerCase() === item.symbol.toLowerCase());
                              return (
                                <tr key={index} className="hover:bg-slate-800/20 transition-all bg-rose-500/[0.02]">
                                  <td className="py-4 px-4 font-bold text-white">
                                    <div className="leading-none">{item.name}</div>
                                    <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">{item.symbol}</span>
                                  </td>
                                  <td className="py-4 px-4">
                                    {item.sentiment === "bearish" ? (
                                      <span className="px-2 py-0.5 rounded text-[10px] bg-rose-500/10 text-rose-400 border border-rose-500/20 uppercase tracking-wider font-bold">
                                        Bearish
                                      </span>
                                    ) : (
                                      <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 uppercase tracking-wider font-bold">
                                        Bullish
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-4 px-4 text-slate-300 font-mono text-[11px]">
                                    <div className="text-rose-400 font-bold mb-1 flex items-center gap-1.5">
                                      <AlertTriangle className="h-3.5 w-3.5" />
                                      {resEntry ? resEntry.status.toUpperCase() : "FAILED"}
                                    </div>
                                    <div className="text-slate-400 italic">
                                      {resEntry ? resEntry.message : "Submission failed"}
                                    </div>
                                  </td>
                                  <td className="py-4 px-4 text-center">
                                    <div className="flex items-center justify-center">
                                      <button
                                        onClick={() => handleRetrySingle(item.symbol)}
                                        disabled={individualLoading[item.symbol] !== null || isBusy}
                                        className="px-3 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 font-bold font-mono text-[10px] tracking-wide border border-emerald-500/25 transition flex items-center gap-1.5 disabled:opacity-50 disabled:hover:bg-emerald-500/10 disabled:hover:text-emerald-400 cursor-pointer"
                                        title="Click to process and post this specific coin alone. Pause automated posting first."
                                      >
                                        {individualLoading[item.symbol] === "retry" ? (
                                          <RefreshCw className="h-3 w-3 animate-spin" />
                                        ) : (
                                          <Play className="h-3 w-3 fill-current" />
                                        )}
                                        Post / Retry
                                      </button>
                                    </div>
                                  </td>
                                  <td className="py-4 px-4 text-right">
                                    <a
                                      href={item.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-rose-400 hover:text-rose-300 hover:underline inline-flex items-center gap-1 font-semibold"
                                    >
                                      Open <ChevronRight className="h-3 w-3" />
                                    </a>
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* TAB 3: SUBMISSION RESULTS */}
            {activeTab === "results" && (
              <div className="overflow-x-auto rounded-xl border border-slate-850">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-950 text-slate-400 uppercase text-[10px] tracking-widest border-b border-slate-850 font-mono">
                    <tr>
                      <th className="py-3 px-4">Time</th>
                      <th className="py-3 px-4">Asset</th>
                      <th className="py-3 px-4">Sentiment</th>
                      <th className="py-3 px-4">Log Status</th>
                      <th className="py-3 px-4">Execution Message / Details</th>
                      <th className="py-3 px-4 text-center">Interactive Controls</th>
                      <th className="py-3 px-4 text-right">Target Link</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-850/60 bg-slate-900/40">
                    {messagesList.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-500 italic">
                          No generated comments found. Trigger "Generate Comments" or "Full automated cycle" above!
                        </td>
                      </tr>
                    ) : (() => {
                      const pendingItems = messagesList.filter(msgItem => !results.some(r => r.symbol.toLowerCase() === msgItem.symbol.toLowerCase()));
                      return messagesList.map((msgItem, index) => {
                        const item = results.find(r => r.symbol.toLowerCase() === msgItem.symbol.toLowerCase());
                        const pendingIndex = pendingItems.findIndex(p => p.symbol.toLowerCase() === msgItem.symbol.toLowerCase());
                        const seqStr = pendingIndex !== -1 ? `Seq #${pendingIndex + 1}` : "";
                        
                        return (
                          <tr key={index} className="hover:bg-slate-800/20 transition-all">
                            <td className="py-3.5 px-4 font-mono text-slate-500">
                              {item ? (item.timestamp || "N/A") : "Pending"}
                            </td>
                            <td className="py-3.5 px-4">
                              <div className="font-bold text-white leading-none">{msgItem.name}</div>
                              <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">{msgItem.symbol}</span>
                            </td>
                            <td className="py-3.5 px-4 font-bold">
                              {(item?.sentiment || msgItem.sentiment || "bullish") === "bearish" ? (
                                <span className="px-2 py-0.5 rounded text-[10px] bg-rose-500/10 text-rose-400 border border-rose-500/20 uppercase tracking-wider">
                                  Bearish
                                </span>
                              ) : (
                                <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 uppercase tracking-wider">
                                  Bullish
                                </span>
                              )}
                            </td>
                            <td className="py-3.5 px-4 font-semibold">
                              {!item ? (
                                <span className="text-slate-400 flex items-center gap-1.5 font-medium font-mono">
                                  <span className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-pulse"></span>
                                  In Queue {seqStr && <span className="text-[10px] text-slate-500 bg-slate-800/80 px-1.5 py-0.5 rounded border border-slate-750 font-bold ml-1">{seqStr}</span>}
                                </span>
                              ) : item.status === "skipped" ? (
                                <span className="text-slate-400 flex items-center gap-1 font-bold">
                                  <AlertTriangle className="h-3.5 w-3.5" /> Skipped (DEX)
                                </span>
                              ) : item.status === "success" ? (
                                <span className="text-emerald-400 flex items-center gap-1 font-bold">
                                  <CheckCircle className="h-3.5 w-3.5" /> Post Submitted
                                </span>
                              ) : item.status === "captcha" ? (
                                <span className="text-amber-400 flex items-center gap-1 font-bold">
                                  <AlertTriangle className="h-3.5 w-3.5 animate-bounce" /> Captcha Detected
                                </span>
                              ) : (
                                <span className="text-red-400 flex items-center gap-1 font-bold">
                                  <AlertTriangle className="h-3.5 w-3.5" /> {item.status.toUpperCase()}
                                </span>
                              )}
                            </td>
                            <td className="py-3.5 px-4 text-slate-300 font-mono text-[11px] max-w-xs truncate" title={item ? item.message : msgItem.message}>
                              {item ? item.message : `Generated: "${msgItem.message.substring(0, 40)}..."`}
                            </td>
                            
                             {/* Manual post retry controls */}
                            <td className="py-3.5 px-4 text-center">
                              {item && item.status !== "success" ? (
                                <div className="flex items-center justify-center">
                                  <button
                                    onClick={() => handleRetrySingle(msgItem.symbol)}
                                    disabled={individualLoading[msgItem.symbol] !== null || isBusy}
                                    className="px-2.5 py-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 font-bold font-mono text-[10px] tracking-wide border border-emerald-500/25 transition flex items-center gap-1 disabled:opacity-50 disabled:hover:bg-emerald-500/10 disabled:hover:text-emerald-400 cursor-pointer"
                                    title="Manually trigger post execution for this coin alone"
                                  >
                                    {individualLoading[msgItem.symbol] === "retry" ? (
                                      <RefreshCw className="h-2.5 w-2.5 animate-spin" />
                                    ) : (
                                      <Play className="h-2.5 w-2.5 fill-current" />
                                    )}
                                    Post/Retry
                                  </button>
                                </div>
                              ) : (
                                <span className="text-slate-600 font-mono text-[11px]">—</span>
                              )}
                            </td>

                            <td className="py-3.5 px-4 text-right">
                              <a
                                href={msgItem.url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-blue-400 hover:text-blue-300 hover:underline inline-flex items-center gap-1 font-semibold"
                              >
                                Verify <ChevronRight className="h-3 w-3" />
                              </a>
                            </td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            )}

            {/* TAB 4: CSV EXPORTS & REPORTS */}
            {activeTab === "reports" && (
              <div className="space-y-8">
                {/* 4.1. CSV Exporters Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                  
                  <div className="p-5 bg-slate-950 rounded-2xl border border-slate-800 flex flex-col justify-between hover:border-slate-700 transition">
                    <div className="space-y-2">
                      <div className="p-2.5 bg-blue-500/10 text-blue-400 rounded-xl border border-blue-500/20 w-fit">
                        <FileText className="h-5 w-5" />
                      </div>
                      <h3 className="font-bold text-white text-sm">Trending Coins CSV</h3>
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        Complete log report containing details of the top trending assets, dynamic live price changes, ranks, and coin URLs.
                      </p>
                    </div>
                    <a
                      href={resolveUrl("/api/download/trending_coins.csv")}
                      className="mt-4 w-full py-2 bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 rounded-xl font-bold text-xs flex items-center justify-center gap-2 hover:text-white transition"
                    >
                      <Download className="h-3.5 w-3.5 text-blue-400" /> Download CSV
                    </a>
                  </div>

                  <div className="p-5 bg-slate-950 rounded-2xl border border-slate-800 flex flex-col justify-between hover:border-slate-700 transition">
                    <div className="space-y-2">
                      <div className="p-2.5 bg-purple-500/10 text-purple-400 rounded-xl border border-purple-500/20 w-fit">
                        <FileText className="h-5 w-5" />
                      </div>
                      <h3 className="font-bold text-white text-sm">Generated Comments CSV</h3>
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        Complete listing of generated custom comments ready for automated Playwright commenting.
                      </p>
                    </div>
                    <a
                      href={resolveUrl("/api/download/generated_comments.csv")}
                      className="mt-4 w-full py-2 bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 rounded-xl font-bold text-xs flex items-center justify-center gap-2 hover:text-white transition"
                    >
                      <Download className="h-3.5 w-3.5 text-purple-400" /> Download CSV
                    </a>
                  </div>

                  <div className="p-5 bg-slate-950 rounded-2xl border border-slate-800 flex flex-col justify-between hover:border-slate-700 transition">
                    <div className="space-y-2">
                      <div className="p-2.5 bg-emerald-500/10 text-emerald-400 rounded-xl border border-emerald-500/20 w-fit">
                        <FileText className="h-5 w-5" />
                      </div>
                      <h3 className="font-bold text-white text-sm">Post Submissions CSV</h3>
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        Detailed execution outcome logs representing each individual automated browser posting session.
                      </p>
                    </div>
                    <a
                      href={resolveUrl("/api/download/post_submissions.csv")}
                      className="mt-4 w-full py-2 bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 rounded-xl font-bold text-xs flex items-center justify-center gap-2 hover:text-white transition"
                    >
                      <Download className="h-3.5 w-3.5 text-emerald-400" /> Download CSV
                    </a>
                  </div>

                  <div className="p-5 bg-slate-950 rounded-2xl border border-slate-800 flex flex-col justify-between hover:border-slate-700 transition">
                    <div className="space-y-2">
                      <div className="p-2.5 bg-amber-500/10 text-amber-400 rounded-xl border border-amber-500/20 w-fit">
                        <FileText className="h-5 w-5" />
                      </div>
                      <h3 className="font-bold text-white text-sm">Overall Report CSV</h3>
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        High-level summary representing overall run health, conversion rates, counts, and bot execution parameters.
                      </p>
                    </div>
                    <a
                      href={resolveUrl("/api/download/overall_report.csv")}
                      className="mt-4 w-full py-2 bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 rounded-xl font-bold text-xs flex items-center justify-center gap-2 hover:text-white transition"
                    >
                      <Download className="h-3.5 w-3.5 text-amber-400" /> Download CSV
                    </a>
                  </div>

                </div>

                {/* 4.2. Beautiful Interactive Analytics Center */}
                <div className="pt-6 border-t border-slate-850">
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                    
                    {/* Success Rate Pie Chart (Radial SVG Chart) */}
                    <div className="lg:col-span-5 bg-slate-950 p-5 rounded-2xl border border-slate-800/80 flex flex-col items-center justify-center space-y-4">
                      <h4 className="font-bold text-white text-xs uppercase tracking-wider text-center">Submission Success Rate</h4>
                      
                      {results.length === 0 ? (
                        <div className="py-12 text-center text-xs text-slate-500 italic">
                          No submissions executed yet to compute analytics.
                        </div>
                      ) : (
                        <div className="flex flex-col items-center space-y-4 w-full">
                          <div className="relative flex items-center justify-center w-36 h-36">
                            {/* SVG Radial Ring */}
                            <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
                              {/* Background Circle */}
                              <circle
                                cx="50"
                                cy="50"
                                r="40"
                                fill="transparent"
                                stroke="#1e293b"
                                strokeWidth="10"
                              />
                              {/* Success Slice */}
                              <circle
                                cx="50"
                                cy="50"
                                r="40"
                                fill="transparent"
                                stroke="#10b981"
                                strokeWidth="10"
                                strokeDasharray={2 * Math.PI * 40}
                                strokeDashoffset={2 * Math.PI * 40 - (results.filter(r => r.status === "success").length / (results.filter(r => r.status !== "skipped").length || 1)) * (2 * Math.PI * 40)}
                                strokeLinecap="round"
                              />
                            </svg>
                            <div className="absolute flex flex-col items-center justify-center">
                              <span className="text-2xl font-extrabold text-white">
                                {Math.round((results.filter(r => r.status === "success").length / (results.filter(r => r.status !== "skipped").length || 1)) * 100)}%
                              </span>
                              <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Success</span>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-4 w-full text-center">
                            <div className="bg-slate-900/40 p-2.5 rounded-xl border border-slate-800/40">
                              <div className="text-[10px] text-slate-400 font-medium">Successful</div>
                              <div className="text-sm font-bold text-emerald-400 font-mono">
                                {results.filter(r => r.status === "success").length} / {results.filter(r => r.status !== "skipped").length}
                              </div>
                            </div>
                            <div className="bg-slate-900/40 p-2.5 rounded-xl border border-slate-800/40">
                              <div className="text-[10px] text-slate-400 font-medium">Failed / Skipped</div>
                              <div className="text-sm font-bold text-rose-400 font-mono">
                                {results.filter(r => r.status !== "success" && r.status !== "skipped").length} F / {results.filter(r => r.status === "skipped").length} S
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Overall Conversion & Sentiment Health */}
                    <div className="lg:col-span-7 bg-slate-950 p-5 rounded-2xl border border-slate-800/80 flex flex-col justify-between">
                      <div>
                        <h4 className="font-bold text-white text-xs uppercase tracking-wider mb-4">Sentiment & Channel Statistics</h4>
                        
                        <div className="space-y-4">
                          <div>
                            <div className="flex justify-between items-center text-xs text-slate-400 mb-1.5">
                              <span>Bullish Target Engagement</span>
                              <span className="font-mono text-emerald-400 font-semibold">
                                {messagesList.filter(m => m.sentiment !== "bearish").length} coins
                              </span>
                            </div>
                            <div className="w-full bg-slate-900 h-1.5 rounded-full overflow-hidden">
                              <div
                                className="bg-emerald-400 h-full transition-all duration-500"
                                style={{
                                  width: `${messagesList.length > 0 ? (messagesList.filter(m => m.sentiment !== "bearish").length / messagesList.length) * 100 : 0}%`
                                }}
                              ></div>
                            </div>
                          </div>

                          <div>
                            <div className="flex justify-between items-center text-xs text-slate-400 mb-1.5">
                              <span>Bearish Target Engagement</span>
                              <span className="font-mono text-rose-400 font-semibold">
                                {messagesList.filter(m => m.sentiment === "bearish").length} coins
                              </span>
                            </div>
                            <div className="w-full bg-slate-900 h-1.5 rounded-full overflow-hidden">
                              <div
                                className="bg-rose-400 h-full transition-all duration-500"
                                style={{
                                  width: `${messagesList.length > 0 ? (messagesList.filter(m => m.sentiment === "bearish").length / messagesList.length) * 100 : 0}%`
                                }}
                              ></div>
                            </div>
                          </div>

                          <div>
                            <div className="flex justify-between items-center text-xs text-slate-400 mb-1.5">
                              <span>Total Unique Targets Added</span>
                              <span className="font-mono text-blue-400 font-semibold">
                                {coinsList.length} unique assets
                              </span>
                            </div>
                            <div className="w-full bg-slate-900 h-1.5 rounded-full overflow-hidden">
                              <div className="bg-blue-400 h-full w-full"></div>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="bg-slate-900/30 p-3 rounded-xl border border-slate-800/40 text-[11px] text-slate-400 mt-4 leading-relaxed">
                        <span className="font-bold text-slate-200">System Insight:</span> Real-time sentiment categorization uses your generated OpenAI comments database. Ensure your Playwright State credentials in auth/state.json remain updated to maintain maximum success rates.
                      </div>
                    </div>

                  </div>
                </div>
              </div>
            )}

          </div>
        </section>

      </main>

      {/* FOOTER */}
      <footer className="border-t border-slate-900 bg-slate-950 py-6 text-center text-xs text-slate-500">
        <p className="tracking-wide">CoinMarketCap Automated Community Bot Control Panel © 2026. All rights reserved.</p>
      </footer>

      {/* MODAL: PASTE COOKIE SESSION OR LOGIN */}
      {showSessionModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full overflow-hidden shadow-2xl flex flex-col justify-between animate-in fade-in zoom-in-95 duration-150">
            
            {/* Header */}
            <div className="p-5 pb-3 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="p-1.5 bg-emerald-500/10 text-emerald-400 rounded-lg border border-emerald-500/20">
                  <Key className="h-4 w-4" />
                </span>
                <h3 className="font-bold text-white text-sm">
                  Configure Playwright Session
                </h3>
              </div>
              <button
                onClick={() => {
                  setShowSessionModal(false);
                  handleResetLoginState();
                }}
                className="text-slate-400 hover:text-white transition font-bold font-mono text-sm"
              >
                ✕
              </button>
            </div>

            {/* Tab Selection */}
            <div className="px-5 pt-3 flex gap-4 border-b border-slate-800 bg-slate-950/20">
              <button
                onClick={() => setLoginTab("credentials")}
                className={`pb-3 text-xs font-bold transition-all relative ${
                  loginTab === "credentials" ? "text-emerald-400 border-b-2 border-emerald-500" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                1. Automated Login (New)
              </button>
              <button
                onClick={() => setLoginTab("cookies")}
                className={`pb-3 text-xs font-bold transition-all relative ${
                  loginTab === "cookies" ? "text-emerald-400 border-b-2 border-emerald-500" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                2. Paste state.json cookies
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 max-h-[60vh] overflow-y-auto space-y-4">

              {loginTab === "credentials" && (
                <div className="space-y-4 text-xs">
                  <p className="text-slate-300 text-[11px] leading-relaxed">
                    Log in directly using your CoinMarketCap credentials. Our backend Playwright browser will run the login, handle security, and capture/save the <code className="text-emerald-400 font-mono">state.json</code> automatically!
                  </p>

                  {loginStep === "idle" && (
                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <label className="text-[10px] uppercase text-slate-400 font-mono tracking-widest font-bold">Email Address</label>
                        <input
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="your-email@example.com"
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white focus:outline-none focus:border-emerald-500 placeholder-slate-700"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] uppercase text-slate-400 font-mono tracking-widest font-bold">Password</label>
                        <input
                          type="password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="••••••••••••"
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white focus:outline-none focus:border-emerald-500 placeholder-slate-700"
                        />
                      </div>
                      <button
                        onClick={handleStartLogin}
                        className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-xl text-xs transition cursor-pointer shadow-lg shadow-emerald-500/10 flex items-center justify-center gap-2"
                      >
                        Start Automated Login Process
                      </button>
                    </div>
                  )}

                  {loginStep === "authenticating" && (
                    <div className="p-6 bg-slate-950 rounded-xl border border-slate-800 flex flex-col items-center justify-center text-center space-y-3.5">
                      <RefreshCw className="h-8 w-8 text-emerald-400 animate-spin" />
                      <div className="space-y-1">
                        <h4 className="font-bold text-white text-xs">Playwright Session Running...</h4>
                        <p className="text-[11px] text-slate-400 max-w-xs">{loginStatusMessage}</p>
                      </div>
                    </div>
                  )}

                  {loginStep === "otp_required" && (
                    <div className="space-y-4">
                      <div className="p-3 bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded-xl space-y-1.5 text-[11px] leading-relaxed">
                        <span className="font-bold text-white flex items-center gap-1">✉️ Action Required: Verification Code</span>
                        <p>{loginStatusMessage}</p>
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-[10px] uppercase text-slate-400 font-mono tracking-widest font-bold">6-Digit Email Code (OTP)</label>
                        <input
                          type="text"
                          value={otpCode}
                          onChange={(e) => setOtpCode(e.target.value)}
                          placeholder="e.g. 123456"
                          maxLength={6}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-center tracking-widest font-mono text-lg text-emerald-400 focus:outline-none focus:border-emerald-500 placeholder-slate-800"
                        />
                      </div>

                      <div className="flex gap-2">
                        <button
                          onClick={handleCancelLogin}
                          className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleSubmitOtp}
                          className="flex-1 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-xl text-xs font-bold"
                        >
                          Confirm & Verify Code
                        </button>
                      </div>
                    </div>
                  )}

                  {loginStep === "success" && (
                    <div className="p-5 bg-emerald-500/10 rounded-xl border border-emerald-500/20 text-emerald-400 flex flex-col items-center text-center space-y-3">
                      <CheckCircle className="h-10 w-10 text-emerald-400" />
                      <div className="space-y-1">
                        <h4 className="font-bold text-white text-sm">Authentication Success!</h4>
                        <p className="text-[11px] text-slate-300">{loginStatusMessage}</p>
                      </div>
                      <button
                        onClick={() => {
                          setShowSessionModal(false);
                          handleResetLoginState();
                        }}
                        className="py-2 px-5 bg-emerald-500 text-slate-950 font-bold rounded-xl text-xs hover:bg-emerald-400 transition"
                      >
                        Finish & Close Panel
                      </button>
                    </div>
                  )}

                  {loginStep === "failed" && (
                    <div className="space-y-4">
                      <div className="p-5 bg-rose-500/10 rounded-xl border border-rose-500/20 text-rose-400 flex flex-col items-center text-center space-y-3">
                        <AlertTriangle className="h-10 w-10 text-rose-400" />
                        <div className="space-y-1">
                          <h4 className="font-bold text-white text-sm">Login Attempt Failed</h4>
                          <p className="text-[11px] text-slate-300">{loginStatusMessage}</p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={handleCancelLogin}
                          className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleResetLoginState}
                          className="flex-1 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-xl text-xs font-bold"
                        >
                          Retry Login Process
                        </button>
                      </div>
                    </div>
                  )}

                </div>
              )}

              {loginTab === "cookies" && (
                <div className="space-y-3.5 text-xs text-slate-300">
                  <p>
                    Directly paste your existing CoinMarketCap <strong>login cookie storage state</strong> JSON array if you prefer not to enter your credentials.
                  </p>
                  <div className="p-3 bg-slate-950 rounded-lg border border-slate-850 space-y-1.5 text-[11px] leading-relaxed text-slate-400">
                    <span className="font-bold text-white block">How to obtain cookies manually:</span>
                    1. Log into your account on CoinMarketCap in Chrome.<br />
                    2. Use a browser extension like "EditThisCookie" or Playwright CLI to export cookies/storage as a JSON array.<br />
                    3. Paste the complete JSON object below.
                  </div>

                  <div className="p-3 bg-indigo-950/40 border border-indigo-900/50 rounded-lg space-y-1 text-[11px] leading-relaxed text-indigo-300">
                    <span className="font-bold text-white flex items-center gap-1">💡 Persistent Render Deployments:</span>
                    Render containers reset local files on each redeployment or restart. To persist your login session permanently, add an Environment Variable on Render with Key <code className="bg-indigo-950 px-1 py-0.5 rounded text-white font-mono font-bold">AUTH_STATE_JSON</code> and paste this complete JSON string as the Value!
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[11px] uppercase text-slate-400 font-mono tracking-widest font-bold">Paste state.json content</label>
                    <textarea
                      rows={8}
                      value={sessionJson}
                      onChange={(e) => setSessionJson(e.target.value)}
                      placeholder='{ "cookies": [ { "name": "session_token", "value": "..." } ] }'
                      className="w-full bg-slate-950 border border-slate-800/80 rounded-xl p-3 font-mono text-[10px] text-emerald-400 focus:outline-none focus:border-emerald-500 placeholder-slate-700"
                    />
                  </div>
                </div>
              )}

            </div>

            {/* Modal Footer (only for manual cookie tab) */}
            {loginTab === "cookies" && (
              <div className="bg-slate-950 px-5 py-4 border-t border-slate-800 flex items-center justify-end gap-3">
                <button
                  onClick={() => {
                    setShowSessionModal(false);
                    handleResetLoginState();
                  }}
                  className="py-2 px-4 rounded-xl text-slate-400 hover:text-white text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveSession}
                  className="py-2 px-5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-xl text-xs font-bold transition cursor-pointer"
                >
                  Save & Load Session
                </button>
              </div>
            )}

          </div>
        </div>
      )}

    </div>
  );
}
