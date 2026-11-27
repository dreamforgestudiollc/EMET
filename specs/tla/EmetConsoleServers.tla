---- MODULE EmetConsoleServers ----
\* Several EMET servers in one app. Each server entry keeps its own URL,
\* session, token and tag. A request is only ever sent with the token that
\* server issued.
EXTENDS Naturals, FiniteSets

CONSTANTS Servers

VARIABLES
  active,    \* the server the switcher shows
  token,     \* [Servers -> Servers \cup {"none"}]  issuer of the token held for each entry
  sent,      \* set of [dest, tokenFrom] for every request sent
  shown      \* set of servers whose data is on screen now

vars == <<active, token, sent, shown>>

Init ==
  /\ active \in Servers
  /\ token = [s \in Servers |-> "none"]
  /\ sent = {}
  /\ shown = {}

SignInTo(s) ==
  /\ active = s /\ token[s] = "none"
  /\ token' = [token EXCEPT ![s] = s]          \* the token comes from server s
  /\ UNCHANGED <<active, sent, shown>>

Switch(s) ==
  /\ s /= active
  /\ active' = s
  /\ shown' = {}                                \* switching clears the screen
  /\ UNCHANGED <<token, sent>>

Request ==
  /\ token[active] /= "none"
  /\ sent' = sent \cup {[dest |-> active, tokenFrom |-> token[active]]}
  /\ shown' = {active}
  /\ UNCHANGED <<active, token>>

SignOutOf(s) ==
  /\ token[s] /= "none"
  /\ token' = [token EXCEPT ![s] = "none"]
  /\ shown' = shown \ {s}
  /\ UNCHANGED <<active, sent>>

Next == \/ \E s \in Servers : SignInTo(s) \/ Switch(s) \/ SignOutOf(s)
        \/ Request

Spec == Init /\ [][Next]_vars

ServerIsolation == \A r \in sent : r.tokenFrom = r.dest
TokenBoundToIssuer == \A s \in Servers : token[s] \in {"none", s}
NoMixedViews == shown \subseteq {active}
====
