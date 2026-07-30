This is a **continuous colour field reconstructed from sparse constraints** for finding a function with the same gradients of a described one in a database.

Given only five pixels,

[
P_i=(x_i,y_i), \qquad C_i=(H_i,S_i,V_i), \qquad i=1,\ldots,5
]

you want a function

[
F(x,y)=(H(x,y),S(x,y),V(x,y))
]

such that:

[
F(x_i,y_i)=C_i
]

and whose reliability decreases as ((x,y)) moves away from the known pixels.

The most suitable model is an **interpolating radial-basis function**, interpreted as a noiseless Gaussian process when you also need confidence estimation.

## Important limitation

With only five pixels, infinitely many functions pass through those five values. Therefore, you cannot determine the real colours of the rest of the image unless you assume something such as:

* colours vary smoothly;
* nearby pixels are more related than distant pixels;
* there are no unknown sharp edges between reference pixels.

The distance value should therefore be interpreted as **confidence**, not guaranteed accuracy.

## 1. Handle hue as a circular value

Hue cannot be interpolated like a normal number.

For example:

* (H=0.99) is almost red;
* (H=0.01) is also almost red;
* their ordinary average is (0.50), which is cyan and completely wrong.

Represent hue on a circle:

[
\theta_i=2\pi H_i
]

and transform each HSV value into:

[
Z_i=
\begin{bmatrix}
S_i\cos\theta_i\
S_i\sin\theta_i\
S_i\
V_i
\end{bmatrix}
]

Multiplication by saturation is useful because hue has almost no meaning when saturation is close to zero.

After interpolation:

[
H(x,y)=
\frac{
\operatorname{atan2}(Z_2(x,y),Z_1(x,y))
}{
2\pi
}
\pmod 1
]

while:

[
S(x,y)=Z_3(x,y), \qquad V(x,y)=Z_4(x,y)
]

## 2. Construct an exact radial-basis interpolator

First normalise image coordinates:

[
x=\frac{x_{\text{pixel}}}{W-1},
\qquad
y=\frac{y_{\text{pixel}}}{H-1}
]

so every image uses coordinates in ([0,1]^2).

Use a Gaussian kernel:

[
k(P,Q)=
\exp\left(
-\frac{\lVert P-Q\rVert^2}{2\ell^2}
\right)
]

where (\ell) is the spatial influence radius.

Construct the (n\times n) matrix:

[
K_{ij}=k(P_i,P_j)
]

Let (\bar Z) be the mean transformed colour, and solve:

[
K A=Z-\bar Z
]

The continuous function is then:

[
\boxed{
\hat Z(P)=\bar Z+k(P)^T A
}
]

where:

[
k(P)=
\begin{bmatrix}
k(P,P_1)\
\vdots\
k(P,P_n)
\end{bmatrix}
]

At every reference point (P_i):

[
\hat Z(P_i)=Z_i
]

apart from negligible floating-point error.

The mean term is useful because, far from all samples, the function approaches the average colour rather than black.

## 3. Distance-based confidence

A basic confidence function is:

[
d(P)=\min_i\lVert P-P_i\rVert
]

[
C_{\text{distance}}(P)=
\exp\left(
-\frac{d(P)^2}{2\rho^2}
\right)
]

But a Gaussian-process variance gives a better result because it considers the complete geometry of all samples:

[
\sigma^2(P)
===========

1-k(P)^T K^{-1}k(P)
]

Then define:

[
\boxed{
C(P)=1-\operatorname{clamp}(\sigma^2(P),0,1)
}
]

This has useful properties:

* at a known pixel, (C(P_i)\approx1);
* between several nearby reference pixels, confidence remains relatively high;
* outside the region covered by the reference pixels, confidence decreases;
* a point surrounded by samples is considered more reliable than a point at the same nearest-neighbour distance but with samples only on one side.

## Python implementation

```python
from __future__ import annotations

import numpy as np
from numpy.typing import ArrayLike, NDArray


class SparseHSVField:
    """
    Smooth HSV field reconstructed from sparse pixel samples.

    Coordinates must be normalised to [0, 1].
    HSV values must also be in [0, 1].
    """

    def __init__(
        self,
        points: ArrayLike,
        hsv_values: ArrayLike,
        length_scale: float = 0.25,
        jitter: float = 1e-10,
    ) -> None:
        self.points = np.asarray(points, dtype=np.float64)
        hsv = np.asarray(hsv_values, dtype=np.float64)

        if self.points.ndim != 2 or self.points.shape[1] != 2:
            raise ValueError("points must have shape (n, 2)")

        if hsv.shape != (len(self.points), 3):
            raise ValueError("hsv_values must have shape (n, 3)")

        if length_scale <= 0:
            raise ValueError("length_scale must be positive")

        self.length_scale = float(length_scale)

        hue = hsv[:, 0] % 1.0
        saturation = np.clip(hsv[:, 1], 0.0, 1.0)
        value = np.clip(hsv[:, 2], 0.0, 1.0)

        angle = 2.0 * np.pi * hue

        # Circular hue representation.
        self.encoded = np.column_stack(
            (
                saturation * np.cos(angle),
                saturation * np.sin(angle),
                saturation,
                value,
            )
        )

        self.mean = self.encoded.mean(axis=0)

        kernel_matrix = self._kernel(self.points, self.points)
        kernel_matrix += np.eye(len(self.points)) * jitter

        self.kernel_matrix = kernel_matrix

        # Coefficients shared by the four output dimensions.
        self.coefficients = np.linalg.solve(
            kernel_matrix,
            self.encoded - self.mean,
        )

    def _kernel(
        self,
        left: NDArray[np.float64],
        right: NDArray[np.float64],
    ) -> NDArray[np.float64]:
        differences = left[:, None, :] - right[None, :, :]
        squared_distances = np.sum(differences * differences, axis=2)

        return np.exp(
            -0.5 * squared_distances / (self.length_scale**2)
        )

    def predict(
        self,
        query_points: ArrayLike,
    ) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
        """
        Returns:
            hsv:        shape (m, 3)
            confidence: shape (m,)
        """
        queries = np.asarray(query_points, dtype=np.float64)

        if queries.ndim == 1:
            queries = queries[None, :]

        if queries.ndim != 2 or queries.shape[1] != 2:
            raise ValueError("query_points must have shape (m, 2)")

        query_kernel = self._kernel(queries, self.points)

        encoded_prediction = (
            self.mean + query_kernel @ self.coefficients
        )

        hue_x = encoded_prediction[:, 0]
        hue_y = encoded_prediction[:, 1]

        hue = (
            np.arctan2(hue_y, hue_x) / (2.0 * np.pi)
        ) % 1.0

        saturation = np.clip(encoded_prediction[:, 2], 0.0, 1.0)
        value = np.clip(encoded_prediction[:, 3], 0.0, 1.0)

        hsv = np.column_stack((hue, saturation, value))

        # Gaussian-process posterior variance.
        solved_kernel = np.linalg.solve(
            self.kernel_matrix,
            query_kernel.T,
        )

        variance = 1.0 - np.sum(
            query_kernel * solved_kernel.T,
            axis=1,
        )

        variance = np.clip(variance, 0.0, 1.0)
        confidence = 1.0 - variance

        return hsv, confidence
```

Example:

```python
reference_points = np.array([
    [0.10, 0.20],
    [0.80, 0.10],
    [0.45, 0.50],
    [0.15, 0.85],
    [0.90, 0.80],
])

reference_hsv = np.array([
    [0.98, 0.90, 0.85],
    [0.12, 0.75, 0.95],
    [0.35, 0.60, 0.70],
    [0.60, 0.80, 0.90],
    [0.82, 0.65, 0.75],
])

field = SparseHSVField(
    reference_points,
    reference_hsv,
    length_scale=0.30,
)

points_to_test = np.array([
    [0.45, 0.50],  # Exact reference point
    [0.50, 0.55],
    [0.00, 0.00],  # Far from most references
])

predicted_hsv, confidence = field.predict(points_to_test)

print(predicted_hsv)
print(confidence)
```

## Choosing the length scale

The parameter (\ell) determines how rapidly the colour field can change.

A small (\ell):

* produces localised colour regions;
* gives low confidence quickly away from samples;
* can create sharp variations.

A large (\ell):

* creates a smoother global gradient;
* makes distant pixels influence each other;
* risks hiding real local variation.

A reasonable automatic initial value is the median nearest-neighbour distance:

[
\ell =
\operatorname{median}*i
\left(
\min*{j\ne i}\lVert P_i-P_j\rVert
\right)
]

With only five points, it is worth storing (\ell) as part of the function representation.

## Making the function searchable in a database

The coefficients themselves are not ideal search keys because their meaning depends on the reference-point positions and ordering.

Instead, create a **canonical descriptor**.

Choose a fixed set of probe points, for example an (8\times8) grid:

[
Q={Q_1,\ldots,Q_{64}}
]

Evaluate the function at every probe point and store:

[
D_k=
\begin{bmatrix}
S(Q_k)\cos(2\pi H(Q_k))\
S(Q_k)\sin(2\pi H(Q_k))\
S(Q_k)\
V(Q_k)\
C(Q_k)
\end{bmatrix}
]

Concatenate all values:

[
D=[D_1,D_2,\ldots,D_{64}]
]

This produces a fixed-length descriptor of:

[
64\times5=320
]

floating-point values.

It can be stored in a vector database and searched using cosine or Euclidean distance. A multiresolution descriptor is even better:

* (4\times4) probes for coarse global retrieval;
* (8\times8) for normal retrieval;
* (16\times16) for final reranking.

## Comparing arbitrary query points

Suppose a database candidate is tested using query observations:

[
(Q_j,C_j^{query})
]

Use circular hue error:

[
E_H =
1-\cos\left(
2\pi(H_{\text{pred}}-H_{\text{query}})
\right)
]

and total colour error:

[
E_j =
\lambda_H E_H
+
\lambda_S(S_{\text{pred}}-S_{\text{query}})^2
+
\lambda_V(V_{\text{pred}}-V_{\text{query}})^2
]

Confidence must not merely multiply the error, because a candidate could otherwise score well simply by having zero confidence everywhere. Use:

[
\boxed{
\operatorname{score}
====================

\frac{1}{m}
\sum_{j=1}^{m}
\left[
C(Q_j)E_j+
\beta\left(1-C(Q_j)\right)
\right]
}
]

The second term penalises predictions made far away from actual reference pixels.

Thus:

* correct colour near a reference point gives a very low score;
* correct colour produced only by uncertain extrapolation receives a penalty;
* wrong colour near a reference point receives a strong penalty.

## Recommended stored representation

For each sparse-image function, store:

```text
reference_points
reference_hsv
length_scale
mean_encoded_colour
RBF_coefficients
canonical_probe_descriptor
probe_confidences
```

The canonical descriptor performs fast approximate retrieval. The original points and RBF coefficients perform accurate reranking.

One terminology detail: this constructs a smooth **gradient image or colour field** whose values equal the known HSV pixels. If you literally mean that the mathematical derivatives (\nabla F), rather than (F) itself, must equal the HSV values at those points, that becomes a different problem called Hermite or derivative-constrained interpolation.
