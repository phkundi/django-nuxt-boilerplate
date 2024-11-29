import { defineStore } from "pinia";
import { jwtDecode } from "jwt-decode";
import dayjs from "dayjs";
import { getEndpoint } from "~/endpoints/endpoints";
import { useAuthCookies } from "~/composables/useAuthCookies";
import {
  type AuthState,
  type LoginCredentials,
  type RegisterCredentials,
  type ResetPasswordCredentials,
  type User,
} from "~/types/auth";

interface TokenResponse {
  access: string;
  refresh: string;
}

interface JWTPayload {
  exp: number;
  // Add other JWT claims you might use
  iat?: number;
  sub?: string;
  user_id: number | string;
}

interface ExtendedRequestInit extends RequestInit {
  data?: any;
}

export const useAuthStore = defineStore("auth", {
  state: (): AuthState => ({
    user: null,
    isAuthenticated: false,
    isInitialized: false,
  }),
  actions: {
    async initializeAuth() {
      try {
        const token = await this.retrieveValidToken();
        if (token) {
          await this.fetchUser();
        }
      } catch (error) {
        console.error("Auth initialization error:", error);
        this.logout();
      } finally {
        this.isInitialized = true;
      }
    },
    async register(
      credentials: RegisterCredentials,
      inviterId?: string
    ): Promise<User> {
      try {
        const url = getEndpoint({ path: "auth.register" });
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ credentials, inviterId }),
        });
        const data = await response.json();

        if (response.status !== 201) {
          throw {
            status: response.status,
            data,
          };
        }

        const userData = await this.login({
          email: credentials.email,
          password: credentials.password,
        });
        return userData;
      } catch (error) {
        console.error("Registration error:", error);
        throw error;
      }
    },
    async login(
      credentials: LoginCredentials,
      remember: boolean = false
    ): Promise<User> {
      try {
        const url = getEndpoint({ path: "auth.login" });
        const response = await $fetch<TokenResponse>(url, {
          method: "POST",
          body: JSON.stringify(credentials),
        });

        const { setAccessToken, setRefreshToken } = useAuthCookies();

        setAccessToken(response.access, remember);
        setRefreshToken(response.refresh, remember);

        this.isAuthenticated = true;

        // Add a small delay to ensure cookies are set
        await new Promise((resolve) => setTimeout(resolve, 100));

        const userData = await this.fetchUser();
        return userData;
      } catch (error) {
        console.error("Login error:", error);
        throw error;
      }
    },
    logout() {
      const { setAccessToken, setRefreshToken } = useAuthCookies();
      setAccessToken(null);
      setRefreshToken(null);
      this.user = null;
      this.isAuthenticated = false;
    },
    async forgotPassword(email: string) {
      try {
        const url = getEndpoint({ path: "auth.forgotPassword" });
        const response = await fetch(url, {
          method: "POST",
          body: JSON.stringify({ email }),
          headers: { "Content-Type": "application/json" },
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.message);
        }
      } catch (error) {
        console.error("Forgot password error:", error);
        throw error;
      }
    },
    async resetPassword(
      credentials: ResetPasswordCredentials,
      user_id: string,
      token: string
    ) {
      try {
        const url = getEndpoint({
          path: "auth.resetPassword",
          params: { user_id, token },
        });
        const response = await fetch(url, {
          method: "POST",
          body: JSON.stringify(credentials),
          headers: { "Content-Type": "application/json" },
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.message);
        }

        const data = await response.json();
        return data;
      } catch (error) {
        console.error("Reset password error:", error);
        throw error;
      }
    },
    async fetchUser(): Promise<User> {
      try {
        const url = getEndpoint({ path: "auth.getUser" });
        const response = await this.authedGet(url);
        const data = await response.json();

        this.user = data;
        this.isAuthenticated = true;

        return data;
      } catch (error) {
        console.error("Fetch user error:", error);
        throw error;
      }
    },
    async retrieveValidToken(): Promise<string | null> {
      const { getAccessToken, setAccessToken, setRefreshToken } =
        useAuthCookies();

      const token = getAccessToken();
      if (!token) {
        console.log("No access token found");
        return null;
      }

      const user = jwtDecode<JWTPayload>(token);
      const isExpired = dayjs.unix(user.exp).diff(dayjs(), "minute") < 5;

      if (isExpired) {
        try {
          const newTokens = await this.refreshToken();
          if (newTokens) {
            setAccessToken(newTokens.access);
            setRefreshToken(newTokens.refresh);
            return newTokens.access;
          }
        } catch (err) {
          console.error("Error refreshing token", err);
          return null;
        }
      }

      return token;
    },
    async refreshToken(): Promise<TokenResponse | null> {
      const { getRefreshToken, setRefreshToken } = useAuthCookies();
      const refreshToken = getRefreshToken();
      if (!refreshToken) return null;

      try {
        const url = getEndpoint({ path: "auth.refreshToken" });
        const response = await $fetch<TokenResponse>(url, {
          method: "POST",
          body: JSON.stringify({ refresh: refreshToken }),
        });
        setRefreshToken(response.refresh);
        return response;
      } catch (error) {
        console.error("Failed to refresh token:", error);
        this.logout();
        return null;
      }
    },

    async authedRequest(
      url: string,
      originalConfig: ExtendedRequestInit = {}
    ): Promise<Response> {
      const config = { ...originalConfig };
      const accessToken = await this.retrieveValidToken();

      if (!accessToken) {
        console.log("No auth token found");
        this.logout();
        return Promise.reject("No auth token found");
      }

      if (!config.headers) {
        config.headers = {};
      }
      (config.headers as Record<string, string>)[
        "Authorization"
      ] = `Bearer ${accessToken}`;

      if (config.data) {
        config.body = config.data;
        delete config.data;
      }

      try {
        return await fetch(url, config);
      } catch (error) {
        console.error("Failed to make authenticated request:", error);
        return Promise.reject(error);
      }
    },

    async makeRequest(
      method: string,
      url: string,
      data: any = {},
      config: ExtendedRequestInit = {}
    ): Promise<Response> {
      config.method = method;
      if (data && Object.keys(data).length > 0) {
        config.data = data;
      }
      return await this.authedRequest(url, config);
    },

    async authedPost(url: string, data: any, config: ExtendedRequestInit = {}) {
      return this.makeRequest("POST", url, data, config);
    },

    async authedPut(url: string, data: any, config: ExtendedRequestInit = {}) {
      return this.makeRequest("PUT", url, data, config);
    },

    async authedPatch(
      url: string,
      data: any,
      config: ExtendedRequestInit = {}
    ) {
      return this.makeRequest("PATCH", url, data, config);
    },

    async authedGet(url: string, config: ExtendedRequestInit = {}) {
      return this.makeRequest("GET", url, null, config);
    },

    async authedDelete(url: string, config: ExtendedRequestInit = {}) {
      return this.makeRequest("DELETE", url, null, config);
    },
  },
});
