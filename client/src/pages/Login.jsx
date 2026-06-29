import { useState } from "react";
import { Link, useNavigate, Navigate } from "react-router-dom";
import { TrendingUp, AlertCircle, Eye, EyeOff, Brain, BarChart3, Target, Shield } from "lucide-react";
import { useAuth } from "../context/AuthContext.jsx";

const FEATURES = [
  { icon: <Brain className="w-5 h-5" />, text: "Multi-agent AI research pipeline" },
  { icon: <BarChart3 className="w-5 h-5" />, text: "Live financial data from 135+ exchanges" },
  { icon: <Target className="w-5 h-5" />, text: "Instant Invest / Watch / Pass verdict" },
  { icon: <Shield className="w-5 h-5" />, text: "Risk factors & bull-case analysis" },
];

export default function Login() {
  const { login, currentUser, loading } = useAuth();
  const navigate = useNavigate();

  // Already logged in → go home
  if (!loading && currentUser) return <Navigate to="/" replace />;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await login(email.trim(), password);
      navigate("/");
    } catch (err) {
      const msg = err?.message ?? "";
      if (msg.includes("Invalid credentials") || msg.includes("401")) {
        setError("Incorrect email or password. Please try again.");
      } else {
        setError(msg || "Login failed. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex font-sans">

      {/* ── LEFT PANEL (dark) ── */}
      <div className="hidden lg:flex lg:w-[480px] xl:w-[520px] flex-shrink-0 bg-finto-dark flex-col justify-between p-12 relative overflow-hidden">
        {/* Background glow */}
        <div className="absolute top-0 right-0 w-80 h-80 bg-finto-primary opacity-10 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-64 h-64 bg-finto-primary opacity-5 rounded-full blur-3xl -ml-16 -mb-16 pointer-events-none" />

        {/* Logo */}
        <Link to="/" className="flex items-center gap-3 relative z-10">
          <div className="w-9 h-9 rounded-full bg-finto-primary flex items-center justify-center">
            <TrendingUp className="w-5 h-5 text-finto-dark" />
          </div>
          <span className="font-extrabold text-xl text-white tracking-tight">ARIA</span>
        </Link>

        {/* Headline + features */}
        <div className="relative z-10">
          <h2 className="text-4xl font-extrabold text-white leading-tight mb-4 tracking-tight">
            Institutional Research,<br />in Seconds.
          </h2>
          <p className="text-green-200/60 text-sm mb-10 leading-relaxed">
            AI-powered stock analysis for every investor — from first-time traders to fund managers.
          </p>
          <div className="flex flex-col gap-4">
            {FEATURES.map((f) => (
              <div key={f.text} className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center text-finto-primary flex-shrink-0">
                  {f.icon}
                </div>
                <span className="text-sm text-green-100/80 font-medium">{f.text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer note */}
        <p className="text-xs text-green-200/30 relative z-10">
          For informational purposes only. Not financial advice.
        </p>
      </div>

      {/* ── RIGHT PANEL (form) ── */}
      <div className="flex-1 flex flex-col bg-finto-bg">
        {/* Mobile logo */}
        <div className="lg:hidden px-6 pt-6">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-finto-text flex items-center justify-center">
              <TrendingUp className="w-4 h-4 text-white" />
            </div>
            <span className="font-extrabold text-xl tracking-tight text-finto-text">ARIA</span>
          </Link>
        </div>

        <div className="flex-1 flex items-center justify-center px-6 py-12">
          <div className="w-full max-w-[420px]">

            {/* Heading */}
            <div className="mb-8">
              <h1 className="text-3xl font-extrabold text-finto-text tracking-tight mb-2">
                Welcome back
              </h1>
              <p className="text-gray-500 text-sm">
                Sign in to access your research and watchlist.
              </p>
            </div>

            {/* Error */}
            {error && (
              <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-6">
                <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            {/* Form */}
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              {/* Email */}
              <div>
                <label className="block text-xs font-bold text-gray-500 tracking-widest uppercase mb-2">
                  Email Address
                </label>
                <input
                  id="login-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full px-4 py-3 bg-white border border-gray-200 rounded-xl text-sm text-finto-text placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-finto-primary focus:border-transparent transition-all shadow-sm"
                />
              </div>

              {/* Password */}
              <div>
                <label className="block text-xs font-bold text-gray-500 tracking-widest uppercase mb-2">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="login-password"
                    type={showPass ? "text" : "password"}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full px-4 py-3 pr-11 bg-white border border-gray-200 rounded-xl text-sm text-finto-text placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-finto-primary focus:border-transparent transition-all shadow-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass((v) => !v)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Submit */}
              <button
                id="login-submit"
                type="submit"
                disabled={submitting}
                className="w-full bg-finto-primary text-finto-dark font-bold py-3.5 rounded-xl hover:bg-finto-primary-hover transition-colors shadow-sm disabled:opacity-60 disabled:cursor-not-allowed text-sm mt-1"
              >
                {submitting ? "Signing In…" : "Sign In"}
              </button>
            </form>

            {/* Divider */}
            <div className="flex items-center gap-3 my-6">
              <div className="flex-1 h-px bg-gray-200" />
              <span className="text-xs text-gray-400 font-medium">or</span>
              <div className="flex-1 h-px bg-gray-200" />
            </div>

            <p className="text-center text-sm text-gray-500">
              Don't have an account?{" "}
              <Link to="/signup" className="text-finto-dark font-bold hover:text-finto-primary transition-colors">
                Sign up free
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
