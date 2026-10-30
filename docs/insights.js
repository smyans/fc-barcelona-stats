"use strict";

// Written interpretation for heatmap cells, keyed "Group|metric" ("*" = any group without its own entry).
// Every number quoted here comes from results/ (see wins_vs_losses_medians.csv and correlations.csv).
const INSIGHTS = {
  "Attackers|xg": "This is the clearest signal on the whole board. In wins, the typical Barça forward produced almost twice the xG of a defeat " +
    "(0.40 vs 0.22 per 90). It sounds obvious, but that's the point: with this squad, the result mostly came down to whether the forwards got good looks at goal.",
  "Attackers|xa": "Barça's forwards created as much as they finished. Messi, Neymar and Suárez set up chances for each other, and a forward's expected " +
    "assists track the result almost as closely as his shots do.",
  "Attackers|shots": "Volume helps, but less than quality. Shots are a weaker signal than xG: twenty shots from distance against a packed defence " +
    "don't win games, and five from inside the six-yard box usually do.",
  "Attackers|touches_in_box": "Getting on the ball in the box goes with winning, but more weakly than xG. Touches only matter if they turn into good chances.",
  "Attackers|pressures": "One of the most Barça-specific findings here. Forwards who press more are linked to winning. The high press that defined " +
    "Guardiola-era Barça (win the ball back high, immediately) shows up in the data: pressing from the front wasn't just style, it went with results.",
  "Attackers|middle_third_recoveries": "Forwards winning the ball back in midfield is linked to winning too. When the front line was tracking back and " +
    "picking up loose balls, the team was usually in control.",
  "Attackers|tackles": "Even forwards' tackling goes with winning. It's a small effect, but it points the same way as pressing: a front line that defends.",
  "Attackers|tackles_won": "Small but real: forwards winning tackles goes with winning matches, the same story as pressing.",
  "Midfielders|xa": "Midfield chance creation is joint-strongest midfield signal, alongside switches of play. The final ball from Xavi, Iniesta and their successors mattered.",
  "Midfielders|switches": "Midfielders who switch play from one flank to the other are linked to winning. Against a deep block, moving the ball quickly " +
    "across the pitch is how you open gaps. Sideways passing isn't always safe; sometimes it's what breaks a defence down.",
  "Midfielders|pass_completion_pct": "Unlike at the 2022 World Cup, pass completion matters here, a little. For a Barça midfield built around Xavi, Iniesta and " +
    "Busquets, keeping the ball cleanly was the whole plan. On days it slipped below their usual 90% or so, results suffered.",
  "Midfielders|progressive_carries": "The one stat that clearly goes with dropping points. Midfielders carrying the ball forward more often is a sign that the " +
    "passing lanes are closed and someone has to force it, which is what happens against a well-organised low block.",
  "Midfielders|middle_third_recoveries": "Midfielders winning the ball back in midfield goes with winning: the counter-press in action.",
  "Midfielders|long_balls": "A small positive link. An occasional long diagonal over a high line is a useful change of pace for a team that usually plays short.",
  "Defenders|switches": "The only defender stat with real evidence behind it. Centre-backs and full-backs who switch play quickly help pull deep " +
    "defences apart. Otherwise, defenders' individual numbers barely move with the result: their job was mostly to recycle the ball, and they did it " +
    "the same way whether Barça won or not.",
  "Defenders|clearances": "Clearances barely differ between wins and defeats. Barça's defenders rarely had to defend their own box, whatever the result.",
  "*|pass_completion_pct": "For this position, pass completion barely moves with the result. Everyone in this team passed accurately, so it can't separate good days from bad.",
};
